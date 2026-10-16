/**
 * 房间服务：局域网 HTTP + WebSocket 监听，承载客人页面与连接层握手。
 *
 * - 默认端口被占用时自动顺延（仅 EADDRINUSE，最多 20 次且不超过 65535）；
 * - 握手阶段校验封包结构、协议版本与房主凭据，非法输入不会导致进程异常；
 * - 房主离开/关闭、宿主进程退出都会释放全部 socket 与监听端口。
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildServerMessage,
  closeCodeForError,
  parseClientMessage,
  WS_PATH,
  type MemberSnapshot,
  type Role,
  type RoomClosedReason,
  type ServerErrorCode,
} from '../src/network/protocol.js';
import { defaultLogger, type Logger } from './log.js';

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
  /** 客人页面（开发为 Vite middleware，生产为静态 dist）。 */
  requestListener?: (request: IncomingMessage, response: ServerResponse) => void;
  logger?: Logger;
}

interface RoomMember {
  id: string;
  role: Role;
  name: string;
  socket: WebSocket | null;
  connected: boolean;
}

const HOST_NAME = '房主';
const GUEST_NAME = '客人';
const DEFAULT_MAX_PORT_ATTEMPTS = 20;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const CLOSE_DRAIN_TIMEOUT_MS = 1_000;

function memberSnapshot(member: RoomMember): MemberSnapshot {
  return { id: member.id, role: member.role, name: member.name, connected: member.connected };
}

function generateToken(): string {
  return randomBytes(16).toString('hex');
}

function generateId(): string {
  return randomBytes(8).toString('hex');
}

export class RoomServer {
  readonly roomId: string;
  readonly hostToken: string;

  private readonly options: Required<Pick<RoomServerOptions, 'maxPortAttempts' | 'handshakeTimeoutMs'>> & RoomServerOptions;
  private readonly logger: Logger;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly tcpSockets = new Set<Socket>();
  private readonly openSockets = new Set<WebSocket>();
  private host: RoomMember | null = null;
  private guest: RoomMember | null = null;
  private closed = false;
  private port = 0;

  constructor(options: RoomServerOptions) {
    this.options = {
      ...options,
      maxPortAttempts: options.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    };
    this.logger = options.logger ?? defaultLogger;
    this.roomId = generateId();
    this.hostToken = generateToken();
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

  get actualPort(): number {
    return this.port;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getMembers(): MemberSnapshot[] {
    const members: MemberSnapshot[] = [];
    if (this.host) {
      members.push(memberSnapshot(this.host));
    }
    if (this.guest) {
      members.push(memberSnapshot(this.guest));
    }
    return members;
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

  /** 房主显式关闭房间：广播 room.closed 后释放全部资源（幂等）。 */
  async closeRoom(reason: RoomClosedReason = 'host-closed'): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.logger('room.closing', { room: this.roomId, reason });

    const notice = buildServerMessage({
      type: 'room.closed',
      roomId: this.roomId,
      payload: { reason },
    });

    for (const socket of [...this.openSockets]) {
      try {
        socket.send(notice);
        socket.close(closeCodeForError('ROOM_CLOSED'), reason);
      } catch {
        // socket 可能已断开。
      }
    }

    if (this.host) {
      this.host.connected = false;
      this.host.socket = null;
    }
    if (this.guest) {
      this.guest.connected = false;
      this.guest.socket = null;
    }

    await this.stopListener();
    this.logger('room.closed', { room: this.roomId, reason });
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

  private handleConnection(socket: WebSocket): void {
    this.openSockets.add(socket);
    const connectionId = generateId();
    let joinedMember: RoomMember | null = null;

    this.logger('ws.connected', { room: this.roomId, conn: connectionId });

    const handshakeTimer = setTimeout(() => {
      if (!joinedMember) {
        this.sendError(socket, 'HANDSHAKE_TIMEOUT', '握手超时');
        socket.close(closeCodeForError('HANDSHAKE_TIMEOUT'), 'handshake-timeout');
      }
    }, this.options.handshakeTimeoutMs);
    handshakeTimer.unref?.();

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

      if (message.type === 'hello') {
        if (joinedMember) {
          this.reject(socket, connectionId, 'INVALID_MESSAGE', 'duplicate-hello');
          return;
        }

        if (message.roomId !== null && message.roomId !== this.roomId) {
          this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
          return;
        }

        const member = this.admitMember(socket, message.payload);
        if (!member) {
          return;
        }
        joinedMember = member;
        clearTimeout(handshakeTimer);

        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: this.roomId,
            payload: {
              roomId: this.roomId,
              memberId: member.id,
              role: member.role,
              name: member.name,
              members: this.getMembers(),
            },
          }),
        );
        this.broadcastMembers();
        this.logger('ws.joined', { room: this.roomId, member: member.id, role: member.role });
        return;
      }

      if (!joinedMember) {
        this.reject(socket, connectionId, 'INVALID_MESSAGE', 'not-handshaked');
        return;
      }

      if (message.type === 'leave') {
        if (message.roomId !== this.roomId) {
          this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
          return;
        }
        this.logger('ws.leave', { room: this.roomId, member: joinedMember.id });
        const member = joinedMember;
        joinedMember = null;
        this.depart(member, 'leave');
        return;
      }

      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'unexpected-type');
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.openSockets.delete(socket);
      this.logger('ws.disconnected', { room: this.roomId, conn: connectionId });

      if (!joinedMember) {
        return;
      }

      const member = joinedMember;
      joinedMember = null;
      this.handleMemberDrop(member);
    });

    socket.on('error', () => {
      // 交给 close 事件统一清理。
    });
  }

  private admitMember(socket: WebSocket, payload: { role: Role; name: string; token?: string }): RoomMember | null {
    if (payload.role === 'host') {
      if (!payload.token || payload.token !== this.hostToken) {
        this.reject(socket, 'host', 'UNAUTHORIZED', 'bad-host-token');
        return null;
      }
      if (this.host?.connected) {
        this.reject(socket, 'host', 'UNAUTHORIZED', 'host-slot-taken');
        return null;
      }
      const member: RoomMember = {
        id: generateId(),
        role: 'host',
        name: HOST_NAME,
        socket,
        connected: true,
      };
      this.host = member;
      return member;
    }

    if (this.guest?.connected) {
      this.reject(socket, 'guest', 'ROOM_FULL', 'guest-slot-taken');
      return null;
    }

    const member: RoomMember = {
      id: generateId(),
      role: 'guest',
      name: GUEST_NAME,
      socket,
      connected: true,
    };
    // 只保留一个客人席位：离线客人卡片被新成员替换，不累积幽灵成员。
    this.guest = member;
    return member;
  }

  private handleMemberDrop(member: RoomMember): void {
    if (member.role === 'host') {
      this.logger('ws.host_dropped', { room: this.roomId, member: member.id });
      void this.closeRoom('host-disconnected');
      return;
    }

    member.connected = false;
    member.socket = null;
    this.logger('ws.guest_dropped', { room: this.roomId, member: member.id });
    this.broadcastMembers();
  }

  private depart(member: RoomMember, reason: 'leave'): void {
    if (member.role === 'host') {
      void this.closeRoom('host-closed');
      return;
    }

    const socket = member.socket;
    member.connected = false;
    member.socket = null;
    this.broadcastMembers();
    this.logger('ws.guest_left', { room: this.roomId, member: member.id, reason });
    try {
      socket?.close(1000, reason);
    } catch {
      // socket 已关闭。
    }
  }

  private broadcastMembers(): void {
    const snapshot = this.getMembers();
    const text = buildServerMessage({
      type: 'members',
      roomId: this.roomId,
      payload: { members: snapshot },
    });
    for (const socket of this.openSockets) {
      // 1 === WebSocket.OPEN
      if (socket.readyState === 1) {
        try {
          socket.send(text);
        } catch {
          // 忽略单个连接的发送失败。
        }
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

  private reject(socket: WebSocket, connectionId: string, code: ServerErrorCode, detail: string): void {
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
