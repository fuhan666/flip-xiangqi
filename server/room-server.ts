/**
 * 房间服务（LAN 适配器）：局域网 HTTP + WebSocket 监听，承载客人页面与连接层握手，
 * 把传输层连接接入共享的权威会话（RoomSession）。
 *
 * 分层：
 * - 本适配器负责真实 socket、编解码与协议校验、握手超时、心跳探测、监听端口策略与静态页面；
 * - 权威状态（大厅/对局/计时/协商/短语/成员与凭据）全部由 RoomSession 持有，这里不再保留第二套权威状态；
 * - 默认端口被占用时自动顺延（仅 EADDRINUSE，最多 20 次且不超过 65535）；
 * - 握手阶段校验封包结构、协议版本与房主凭据，非法输入不会导致进程异常；
 * - 房主离开/关闭、宿主进程退出都会释放全部 socket 与监听端口。
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
} from '../src/network/heartbeat.js';
import {
  buildPong,
  buildServerMessage,
  closeCodeForError,
  parseClientMessage,
  WS_PATH,
  type ClientMessage,
  type MemberSnapshot,
  type RoomClosedReason,
  type ServerErrorCode,
} from '../src/network/protocol.js';
import type { LobbyState } from '../src/network/lobby.js';
import type { MatchSnapshot } from '../src/network/match.js';
import type { PublicMatchSnapshot } from '../src/network/public-game.js';
import { asConnectionId, generateId, type ConnectionId } from './room-identity.js';
import { defaultLogger, type Logger } from './log.js';
import { RoomSession, type SessionConnection } from './room-session.js';

export type RoomServerErrorCode = 'INVALID_PORT' | 'PORT_UNAVAILABLE' | 'NO_PERMISSION' | 'INTERNAL_ERROR';

export class RoomServerError extends Error {
  readonly code: RoomServerErrorCode;

  constructor(code: RoomServerErrorCode, message: string) {
    super(message);
    this.name = 'RoomServerError';
    this.code = code;
  }
}

export interface RoomServerOptions {
  preferredPort: number;
  maxPortAttempts?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** 客人页面（开发为 Vite middleware，生产为静态 dist）。 */
  requestListener?: (request: IncomingMessage, response: ServerResponse) => void;
  logger?: Logger;
  /** 随机分先的一次性裁决（true = 房主执红），默认用密码学随机数，测试可注入。 */
  drawHostRed?: () => boolean;
  /** 随机洗牌种子（32 位无符号整数），默认用密码学随机数，测试可注入。 */
  drawSeed?: () => number;
  /** 注入时间函数（毫秒时间戳），测试可注入受控时钟。 */
  nowFn?: () => number;
  /** 时钟广播周期（毫秒），默认 1000ms。 */
  clockIntervalMs?: number;
  /** 旁观者掉线后的恢复窗口（毫秒），超时未恢复即清理记录，默认 95 秒。 */
  spectatorResumeWindowMs?: number;
}

const DEFAULT_MAX_PORT_ATTEMPTS = 20;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const CLOSE_DRAIN_TIMEOUT_MS = 1_000;

interface SocketWatchdog {
  intervalTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  pendingPongSeq: number | null;
  seq: number;
}

/** WebSocket 连接端口：会话只见 connectionId + 发送/关闭，不接触 socket 细节。 */
class WebSocketConnection implements SessionConnection {
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

export class RoomServer {
  private readonly options: Required<Pick<RoomServerOptions, 'maxPortAttempts' | 'handshakeTimeoutMs' | 'heartbeatIntervalMs' | 'heartbeatTimeoutMs'>> & RoomServerOptions;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** 权威会话：本适配器唯一的权威状态来源。 */
  private readonly session: RoomSession;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly tcpSockets = new Set<Socket>();
  private readonly openSockets = new Set<WebSocket>();
  private readonly watchdogs = new Map<WebSocket, SocketWatchdog>();
  private closed = false;
  private port = 0;

  constructor(options: RoomServerOptions) {
    this.options = {
      ...options,
      maxPortAttempts: options.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };
    this.now = options.nowFn ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger;

    this.session = new RoomSession({
      logger: this.logger,
      nowFn: this.now,
      drawHostRed: options.drawHostRed,
      drawSeed: options.drawSeed,
      clockIntervalMs: options.clockIntervalMs,
      spectatorResumeWindowMs: options.spectatorResumeWindowMs,
      // 会话自身关闭（大厅阶段房主掉线、房主主动离开等）→ 适配器补齐广播投递与监听资源释放。
      onClose: (reason) => {
        void this.closeRoom(reason);
      },
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://room.local').pathname;
      if (pathname === WS_PATH) {
        response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('请通过 WebSocket 连接该地址');
        return;
      }
      if (this.options.requestListener) {
        this.options.requestListener(request, response);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('房间服务已就绪，请从客户端连接');
    });

    this.server.on('connection', (socket) => {
      this.tcpSockets.add(socket);
      socket.on('close', () => this.tcpSockets.delete(socket));
    });

    this.server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'http://room.local').pathname;
      if (pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (webSocket) => {
        this.handleConnection(webSocket);
      });
    });
  }

  get roomId(): string {
    return this.session.roomId;
  }

  get hostToken(): string {
    return this.session.hostToken;
  }

  get actualPort(): number {
    return this.port;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 当前权威成员快照（委托共享会话）。 */
  getMembers(): MemberSnapshot[] {
    return this.session.getMembers();
  }

  /** 当前权威大厅快照（委托共享会话，独立副本）。 */
  getLobby(): LobbyState {
    return this.session.getLobby();
  }

  /** 当前权威对局快照（委托共享会话，无对局时为 null）。 */
  getMatch(): MatchSnapshot | null {
    return this.session.getMatch();
  }

  /** 与下发给客户端的形状一致的公开对局快照。 */
  getPublicMatch(): PublicMatchSnapshot | null {
    return this.session.getPublicMatch();
  }

  isHostConnected(): boolean {
    return this.session.isHostConnected();
  }

  getLobbyPhase(): LobbyState['phase'] {
    return this.session.getLobbyPhase();
  }

  async start(): Promise<number> {
    const { preferredPort, maxPortAttempts } = this.options;

    if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
      throw new RoomServerError('INVALID_PORT', `端口 ${preferredPort} 无效，请在设置中改为 1-65535 之间的整数`);
    }

    for (let attempt = 0; attempt < maxPortAttempts; attempt += 1) {
      const candidate = preferredPort + attempt;
      if (candidate > 65535) {
        break;
      }
      try {
        await this.listenOn(candidate);
        this.port = candidate;
        if (attempt > 0) {
          this.logger('room.port_fallback', { room: this.roomId, port: candidate, attempts: attempt + 1 });
        }
        this.logger('room.listening', { room: this.roomId, port: candidate });
        return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE' && attempt + 1 < maxPortAttempts && candidate + 1 <= 65535) {
          continue;
        }
        if (code === 'EADDRINUSE') {
          throw new RoomServerError(
            'PORT_UNAVAILABLE',
            `端口 ${preferredPort} 起连续 ${attempt + 1} 个端口都被占用，请更换起始端口后重试`,
          );
        }
        if (code === 'EACCES' || code === 'EPERM') {
          throw new RoomServerError('NO_PERMISSION', `没有权限监听端口 ${candidate}，请改用 1024 以上的端口`);
        }
        throw new RoomServerError('INTERNAL_ERROR', `房间服务启动失败：${(error as Error).message}`);
      }
    }

    throw new RoomServerError('PORT_UNAVAILABLE', `端口 ${preferredPort} 起没有可用端口，请更换起始端口后重试`);
  }

  /** 关闭房间（幂等）：会话广播 room.closed 并关闭连接，适配器清心跳、收尾 socket 并释放监听端口。 */
  async closeRoom(reason: RoomClosedReason = 'host-closed'): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    // 会话侧：向全部连接投递 room.closed 并关闭连接、释放领域状态与定时器（幂等）。
    this.session.close(reason);

    // 传输侧：收尾仍未关闭的 socket（room.closed 已由会话经连接端口投递，不重复发送），
    // 清理心跳探测并释放 TCP/WS 监听资源。
    for (const socket of [...this.openSockets]) {
      try {
        socket.close(closeCodeForError('ROOM_CLOSED'), reason);
      } catch {
        // socket 可能已断开。
      }
    }
    this.clearAllWatchdogs();

    await this.stopListener();
  }

  private startWatchdog(socket: WebSocket): void {
    this.clearSocketWatchdog(socket);
    const watchdog: SocketWatchdog = {
      intervalTimer: null,
      timeoutTimer: null,
      pendingPongSeq: null,
      seq: 0,
    };
    this.watchdogs.set(socket, watchdog);

    watchdog.intervalTimer = setInterval(() => {
      // 1 === WebSocket.OPEN
      if (socket.readyState !== 1) {
        this.clearSocketWatchdog(socket);
        return;
      }
      if (watchdog.pendingPongSeq !== null) {
        // 等待旧探测的应答中，既有超时计时器已在计时，不发送新探测
        return;
      }
      watchdog.seq += 1;
      const seq = watchdog.seq;
      watchdog.pendingPongSeq = seq;
      try {
        socket.send(buildServerMessage({ type: 'ping', roomId: this.roomId, payload: { seq } }));
      } catch {
        // 忽略发送失败
      }
      watchdog.timeoutTimer = setTimeout(() => {
        if (watchdog.pendingPongSeq === seq) {
          this.logger('ws.heartbeat_timeout', { room: this.roomId, seq });
          this.clearSocketWatchdog(socket);
          try {
            socket.terminate();
          } catch {
            // socket 可能已关闭
          }
        }
      }, this.options.heartbeatTimeoutMs);
      watchdog.timeoutTimer.unref?.();
    }, this.options.heartbeatIntervalMs);
    watchdog.intervalTimer.unref?.();
  }

  private clearSocketWatchdog(socket: WebSocket): void {
    const wd = this.watchdogs.get(socket);
    if (!wd) {
      return;
    }
    if (wd.intervalTimer) {
      clearInterval(wd.intervalTimer);
      wd.intervalTimer = null;
    }
    if (wd.timeoutTimer) {
      clearTimeout(wd.timeoutTimer);
      wd.timeoutTimer = null;
    }
    this.watchdogs.delete(socket);
  }

  private clearAllWatchdogs(): void {
    for (const socket of [...this.watchdogs.keys()]) {
      this.clearSocketWatchdog(socket);
    }
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, '0.0.0.0');
    });
  }

  private async stopListener(): Promise<void> {
    for (const socket of this.tcpSockets) {
      socket.end();
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of this.tcpSockets) {
          socket.destroy();
        }
        resolve();
      }, CLOSE_DRAIN_TIMEOUT_MS);
      timer.unref?.();
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    this.logger('room.listener_released', { room: this.roomId, port: this.port });
  }

  /** 连接层：真实 socket ↔ 会话连接端口，负责编解码、握手超时与心跳。 */
  private handleConnection(socket: WebSocket): void {
    this.openSockets.add(socket);
    const connectionId = asConnectionId(generateId());
    const connection = new WebSocketConnection(connectionId, socket);

    this.logger('ws.connected', { room: this.roomId, conn: connectionId });

    const handshakeTimer = setTimeout(() => {
      if (!this.session.isHelloComplete(connectionId)) {
        this.sendError(socket, 'HANDSHAKE_TIMEOUT', '握手超时');
        socket.close(closeCodeForError('HANDSHAKE_TIMEOUT'), 'handshake-timeout');
      }
    }, this.options.handshakeTimeoutMs);
    handshakeTimer.unref?.();

    this.session.attach(connection);

    socket.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      const parsed = parseClientMessage(raw);

      if (!parsed.ok) {
        this.logger('ws.invalid_message', { room: this.roomId, conn: connectionId, code: parsed.code, detail: parsed.detail });
        this.sendError(socket, parsed.code, parsed.detail);
        socket.close(closeCodeForError(parsed.code), parsed.code);
        return;
      }

      const message = parsed.message;

      // 心跳（服务端探测与应答）属连接层；其余命令交权威会话裁决。
      if (message.type === 'ping' || message.type === 'pong') {
        this.handleHeartbeat(socket, connectionId, message);
        return;
      }

      this.session.handleMessage(connectionId, message);

      if (message.type === 'hello' && this.session.isHelloComplete(connectionId)) {
        clearTimeout(handshakeTimer);
        this.startWatchdog(socket);
      }
    });

    socket.on('close', (code, reason) => {
      clearTimeout(handshakeTimer);
      this.clearSocketWatchdog(socket);
      this.openSockets.delete(socket);
      // 迟到 close 带原 connectionId：席位已被新连接替换时不误下线新连接。
      this.session.handleDisconnect(connectionId, code, reason.toString());
    });

    socket.on('error', () => {
      // 交给 close 事件统一清理。
    });
  }

  /**
   * 心跳处理：门禁与会话的连接归属校验一致（未握手 / 已被替换的连接一律拒绝），
   * 保证旧连接的迟到心跳不影响新连接。
   */
  private handleHeartbeat(
    socket: WebSocket,
    connectionId: ConnectionId,
    message: Extract<ClientMessage, { type: 'ping' | 'pong' }>,
  ): void {
    const standing = this.session.getStanding(connectionId);
    if (standing === 'superseded') {
      this.reject(socket, connectionId, 'UNAUTHORIZED', 'socket-superseded');
      return;
    }
    if (standing !== 'active') {
      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'not-handshaked');
      return;
    }
    if (message.roomId !== this.roomId) {
      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (message.type === 'ping') {
      const now = this.now();
      try {
        socket.send(
          buildServerMessage(
            buildPong(this.roomId, message.payload.seq, {
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

    const wd = this.watchdogs.get(socket);
    if (wd && wd.pendingPongSeq === message.payload.seq) {
      wd.pendingPongSeq = null;
      if (wd.timeoutTimer) {
        clearTimeout(wd.timeoutTimer);
        wd.timeoutTimer = null;
      }
    }
  }

  private sendError(socket: WebSocket, code: ServerErrorCode, message: string): void {
    try {
      socket.send(
        buildServerMessage({
          type: 'error',
          roomId: this.roomId,
          payload: { code, message },
        }),
      );
    } catch {
      // socket 已关闭。
    }
  }

  private reject(socket: WebSocket, connectionId: ConnectionId, code: ServerErrorCode, detail: string): void {
    this.logger('ws.rejected', { room: this.roomId, conn: connectionId, code, detail });
    this.sendError(socket, code, detail);
    socket.close(closeCodeForError(code), code);
  }
}

export interface StartedRoom {
  server: RoomServer;
  roomId: string;
  hostToken: string;
  port: number;
}

export async function startRoomServer(options: RoomServerOptions): Promise<StartedRoom> {
  const server = new RoomServer(options);
  const port = await server.start();
  return { server, roomId: server.roomId, hostToken: server.hostToken, port };
}
