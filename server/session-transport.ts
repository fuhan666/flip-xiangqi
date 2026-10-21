/**
 * 会话传输适配（LAN 与在线入口共用）：
 * 把一条已升级的 WebSocket 接到 RoomSession 的连接端口，并负责
 * 编解码与协议校验、握手超时、心跳探测/应答、连接归属门禁与资源清理。
 *
 * 领域裁决（大厅/对局/计时/成员）全部留在 RoomSession，这里不复制任何规则。
 */
import type { WebSocket } from 'ws';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
} from '../src/network/heartbeat.js';
import {
  buildPong,
  buildServerMessage,
  closeCodeForError,
  parseClientMessage,
  type ClientMessage,
  type ServerErrorCode,
} from '../src/network/protocol.js';
import type { Logger } from './log.js';
import { asConnectionId, generateId, type ConnectionId } from './room-identity.js';
import type { ConnectionAdmission, RoomSession, SessionConnection } from './room-session.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** WebSocket 连接端口：会话只见 connectionId + 发送/关闭，不接触 socket 细节。 */
class WebSocketSessionConnection implements SessionConnection {
  readonly connectionId: ConnectionId;

  private readonly socket: WebSocket;

  constructor(connectionId: ConnectionId, socket: WebSocket) {
    this.connectionId = connectionId;
    this.socket = socket;
  }

  send(text: string): void {
    // 1 === WebSocket.OPEN
    if (this.socket.readyState !== 1) {
      return;
    }
    try {
      this.socket.send(text);
    } catch {
      // 忽略单个发送失败。
    }
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // socket 可能已关闭。
    }
  }
}

export interface SessionSocketOptions {
  session: RoomSession;
  socket: WebSocket;
  logger: Logger;
  /** 注入时间函数（毫秒时间戳）。 */
  now: () => number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** 在线模式：传输层按凭据解析出的可信身份；LAN 模式不传。 */
  admission?: ConnectionAdmission;
  /** socket 关闭后回调（宿主用于清理登记）。 */
  onClosed?: () => void;
}

export interface SessionSocketHandle {
  readonly connectionId: ConnectionId;
  /** 停止心跳与超时计时器并关闭 socket（幂等）。 */
  dispose(code?: number, reason?: string): void;
}

export function serveSessionSocket(options: SessionSocketOptions): SessionSocketHandle {
  const { session, socket, logger } = options;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const connectionId = asConnectionId(generateId());
  const connection = new WebSocketSessionConnection(connectionId, socket);

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  let pendingPongSeq: number | null = null;
  let pingSeq = 0;
  let disposed = false;

  logger('ws.connected', { room: session.roomId, conn: connectionId });

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
    pendingPongSeq = null;
  };

  const handshakeTimer = setTimeout(() => {
    if (!session.isHelloComplete(connectionId)) {
      sendError('HANDSHAKE_TIMEOUT', '握手超时');
      socket.close(closeCodeForError('HANDSHAKE_TIMEOUT'), 'handshake-timeout');
    }
  }, handshakeTimeoutMs);
  handshakeTimer.unref?.();

  const startHeartbeat = () => {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState !== 1) {
        clearHeartbeat();
        return;
      }
      if (pendingPongSeq !== null) {
        // 等待旧探测的应答中，既有超时计时器已在计时，不发送新探测
        return;
      }
      pingSeq += 1;
      const seq = pingSeq;
      pendingPongSeq = seq;
      try {
        socket.send(buildServerMessage({ type: 'ping', roomId: session.roomId, payload: { seq } }));
      } catch {
        // 忽略发送失败
      }
      heartbeatTimeoutTimer = setTimeout(() => {
        if (pendingPongSeq !== seq) {
          return;
        }
        logger('ws.heartbeat_timeout', { room: session.roomId, seq });
        clearHeartbeat();
        try {
          socket.terminate();
        } catch {
          // socket 可能已关闭
        }
      }, heartbeatTimeoutMs);
      heartbeatTimeoutTimer.unref?.();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  };

  const sendError = (code: ServerErrorCode, message: string) => {
    try {
      socket.send(
        buildServerMessage({
          type: 'error',
          roomId: session.roomId,
          payload: { code, message },
        }),
      );
    } catch {
      // socket 已关闭。
    }
  };

  const reject = (code: ServerErrorCode, detail: string) => {
    logger('ws.rejected', { room: session.roomId, conn: connectionId, code, detail });
    sendError(code, detail);
    socket.close(closeCodeForError(code), code);
  };

  /**
   * 心跳处理：门禁与会话的连接归属校验一致（未握手 / 已被替换的连接一律拒绝），
   * 保证旧连接的迟到心跳不影响新连接；roomId 必须与本房间一致。
   */
  const handleHeartbeat = (message: Extract<ClientMessage, { type: 'ping' | 'pong' }>) => {
    const standing = session.getStanding(connectionId);
    if (standing === 'superseded') {
      reject('UNAUTHORIZED', 'socket-superseded');
      return;
    }
    if (standing !== 'active') {
      reject('INVALID_MESSAGE', 'not-handshaked');
      return;
    }
    if (message.roomId !== session.roomId) {
      reject('INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (message.type === 'ping') {
      const now = options.now();
      try {
        socket.send(
          buildServerMessage(
            buildPong(session.roomId, message.payload.seq, {
              serverReceiveTime: now,
              serverSendTime: now,
            }),
          ),
        );
      } catch {
        // 忽略发送失败
      }
      return;
    }

    if (pendingPongSeq === message.payload.seq) {
      pendingPongSeq = null;
      if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = null;
      }
    }
  };

  session.attach(connection, options.admission);

  socket.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    const parsed = parseClientMessage(raw);

    if (!parsed.ok) {
      logger('ws.invalid_message', {
        room: session.roomId,
        conn: connectionId,
        code: parsed.code,
        detail: parsed.detail,
      });
      sendError(parsed.code, parsed.detail);
      socket.close(closeCodeForError(parsed.code), parsed.code);
      return;
    }

    const message = parsed.message;

    // 心跳（服务端探测与应答）属连接层；其余命令交权威会话裁决。
    if (message.type === 'ping' || message.type === 'pong') {
      handleHeartbeat(message);
      return;
    }

    session.handleMessage(connectionId, message);

    if (
      (message.type === 'hello' || message.type === 'online.hello') &&
      session.isHelloComplete(connectionId)
    ) {
      clearTimeout(handshakeTimer);
      startHeartbeat();
    }
  });

  socket.on('close', (code, reason) => {
    clearTimeout(handshakeTimer);
    clearHeartbeat();
    // 迟到 close 带原 connectionId：席位已被新连接替换时不误下线新连接。
    session.handleDisconnect(connectionId, code, reason.toString());
    options.onClosed?.();
  });

  socket.on('error', () => {
    // 交给 close 事件统一清理。
  });

  return {
    connectionId,
    dispose(code?: number, reason?: string) {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(handshakeTimer);
      clearHeartbeat();
      try {
        if (code !== undefined) {
          socket.close(code, reason);
        }
      } catch {
        // socket 可能已关闭。
      }
    },
  };
}
