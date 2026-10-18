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
  applyLobbyCommand,
  createLobbyState,
  snapshotLobbyState,
  type LobbyCommand,
  type LobbyRejectCode,
  type LobbyState,
} from '../src/network/lobby.js';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
} from '../src/network/heartbeat.js';
import {
  createMatch,
  finalizeMatch,
  snapshotMatch,
  applyMatchAction,
  type MatchAction,
  type MatchSnapshot,
  type MatchState,
} from '../src/network/match.js';
import { createEmptyGameState } from '../src/game/index.js';
import type { GameStateSnapshot } from '../src/game/index.js';
import {
  buildPong,
  buildServerGameClock,
  buildServerMessage,
  closeCodeForError,
  parseClientMessage,
  WS_PATH,
  type ClientMessage,
  type MemberSnapshot,
  type MemberLeaveReason,
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
}

interface RoomMember {
  id: string;
  role: Role;
  name: string;
  socket: WebSocket | null;
  connected: boolean;
  leaveReason: MemberLeaveReason | null;
}

type LobbyClientMessage = Extract<ClientMessage, { type: `lobby.${string}` }>;

const HOST_NAME = '房主';
const GUEST_NAME = '客人';
const DEFAULT_MAX_PORT_ATTEMPTS = 20;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const CLOSE_DRAIN_TIMEOUT_MS = 1_000;

function memberSnapshot(member: RoomMember): MemberSnapshot {
  return {
    id: member.id,
    role: member.role,
    name: member.name,
    connected: member.connected,
    ...(member.connected || !member.leaveReason ? {} : { leaveReason: member.leaveReason }),
  };
}

function defaultDrawHostRed(): boolean {
  return randomBytes(1)[0] % 2 === 0;
}

function defaultDrawSeed(): number {
  if (process.env.TEST_ROOM_SEED) {
    const parsed = Number(process.env.TEST_ROOM_SEED);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff) {
      return parsed >>> 0;
    }
  }
  return randomBytes(4).readUInt32BE(0);
}

function generateToken(): string {
  return randomBytes(16).toString('hex');
}

function generateId(): string {
  return randomBytes(8).toString('hex');
}

interface SocketWatchdog {
  intervalTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  pendingPongSeq: number | null;
  seq: number;
}

export class RoomServer {
  readonly roomId: string;
  readonly hostToken: string;

  private readonly options: Required<Pick<RoomServerOptions, 'maxPortAttempts' | 'handshakeTimeoutMs' | 'heartbeatIntervalMs' | 'heartbeatTimeoutMs'>> & RoomServerOptions;
  private readonly logger: Logger;
  private readonly drawHostRed: () => boolean;
  private readonly drawSeed: () => number;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly tcpSockets = new Set<Socket>();
  private readonly openSockets = new Set<WebSocket>();
  private readonly watchdogs = new Map<WebSocket, SocketWatchdog>();
  private guestResumeToken: string | null = null;
  private readonly processedActions = new Map<string, { stepNumber: number; match: MatchState }>();
  private host: RoomMember | null = null;
  private guest: RoomMember | null = null;
  private lobby: LobbyState;
  private match: MatchState | null = null;
  private closed = false;
  private port = 0;
  private readonly now: () => number;
  private clockTimer: NodeJS.Timeout | null = null;
  private clockBroadcastInterval: NodeJS.Timeout | null = null;

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
    this.drawHostRed = options.drawHostRed ?? defaultDrawHostRed;
    this.drawSeed = options.drawSeed ?? defaultDrawSeed;
    this.roomId = generateId();
    this.hostToken = generateToken();
    this.lobby = createLobbyState();
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

  /** 当前权威大厅快照（独立副本，测试与内部状态隔离）。 */
  getLobby(): LobbyState {
    return snapshotLobbyState(this.lobby);
  }

  /** 当前权威对局快照（无对局时为 null）。 */
  getMatch(): MatchSnapshot | null {
    return this.match ? snapshotMatch(this.match) : null;
  }

  isHostConnected(): boolean {
    return Boolean(this.host?.connected);
  }

  getLobbyPhase(): LobbyState['phase'] {
    return this.lobby.phase;
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

    this.clearAllWatchdogs();
    this.stopClockBroadcast();
    this.clearClockTimer();
    this.processedActions.clear();
    this.guestResumeToken = null;
    this.match = null;

    await this.stopListener();
    this.logger('room.closed', { room: this.roomId, reason });
  }

  private startClockBroadcast(): void {
    this.stopClockBroadcast();
    const intervalMs = this.options.clockIntervalMs ?? 1000;
    this.clockBroadcastInterval = setInterval(() => {
      this.broadcastClock();
    }, intervalMs);
  }

  private stopClockBroadcast(): void {
    if (this.clockBroadcastInterval) {
      clearInterval(this.clockBroadcastInterval);
      this.clockBroadcastInterval = null;
    }
  }

  private clearClockTimer(): void {
    if (this.clockTimer) {
      clearTimeout(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private scheduleClockDeadline(): void {
    this.clearClockTimer();
    if (!this.match || this.match.settlement !== null) {
      return;
    }
    const next = this.match.clock.getNextDeadlineTime(this.now());
    if (next === null) {
      return;
    }
    const delay = Math.max(0, next - this.now());
    this.clockTimer = setTimeout(() => {
      this.checkClockDeadline();
    }, delay + 5);
  }

  private checkClockDeadline(): void {
    if (!this.match || this.match.settlement !== null || this.closed) {
      return;
    }
    const adv = this.match.clock.advance(this.now());
    if (adv.timeoutResult) {
      this.match = finalizeMatch(this.match, adv.timeoutResult.winner, adv.timeoutResult.reason, this.now());
      this.stopClockBroadcast();
      this.clearClockTimer();
      this.logger('game.timeout', {
        room: this.roomId,
        matchId: this.match.matchId,
        winner: adv.timeoutResult.winner,
        reason: adv.timeoutResult.reason,
      });
      this.broadcastGameState();
    }
  }

  private broadcastClock(): void {
    if (!this.match || this.match.settlement !== null || this.closed) {
      return;
    }
    const adv = this.match.clock.advance(this.now());
    if (adv.timeoutResult) {
      this.match = finalizeMatch(this.match, adv.timeoutResult.winner, adv.timeoutResult.reason, this.now());
      this.stopClockBroadcast();
      this.clearClockTimer();
      this.logger('game.timeout', {
        room: this.roomId,
        matchId: this.match.matchId,
        winner: adv.timeoutResult.winner,
        reason: adv.timeoutResult.reason,
      });
      this.broadcastGameState();
      return;
    }

    const snap = snapshotMatch(this.match, this.now());
    const text = buildServerMessage(
      buildServerGameClock(this.roomId, {
        matchId: this.match.matchId,
        revision: this.match.revision,
        sampleSeq: snap.clock.sampleSeq,
        clock: snap.clock,
      }),
    );

    for (const socket of this.openSockets) {
      if (socket.readyState === 1) {
        try {
          socket.send(text);
        } catch {
          // 忽略单个发送失败
        }
      }
    }
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

        // 先落座再发 welcome：快照里带上本人 presence，其他成员收 lobby.state。
        this.applyLobby({ type: 'member-joined', role: member.role }, socket);

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
              lobby: this.getLobby(),
              ...(member.role === 'guest' && this.guestResumeToken ? { resumeToken: this.guestResumeToken } : {}),
              ...(this.match ? { game: snapshotMatch(this.match, this.now()) } : {}),
            },
          }),
        );
        this.broadcastMembers();
        this.startWatchdog(socket);
        this.logger('ws.joined', { room: this.roomId, member: member.id, role: member.role });
        return;
      }

      if (!joinedMember) {
        this.reject(socket, connectionId, 'INVALID_MESSAGE', 'not-handshaked');
        return;
      }

      const activeMember = joinedMember.role === 'host' ? this.host : this.guest;
      if (!activeMember || activeMember.socket !== socket) {
        this.reject(socket, connectionId, 'UNAUTHORIZED', 'socket-superseded');
        return;
      }

      if (message.type === 'ping') {
        if (message.roomId !== this.roomId) {
          this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
          return;
        }
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

      if (message.type === 'pong') {
        if (message.roomId !== this.roomId) {
          this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
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

      if (message.type === 'lobby.return') {
        this.handleLobbyReturn(socket, connectionId, joinedMember, message);
        return;
      }

      if (
        message.type === 'lobby.settings' ||
        message.type === 'lobby.lock' ||
        message.type === 'lobby.ready' ||
        message.type === 'lobby.start'
      ) {
        this.handleLobbyMessage(socket, connectionId, joinedMember, message);
        return;
      }

      if (message.type === 'game.action') {
        this.handleGameAction(socket, connectionId, joinedMember, message);
        return;
      }

      if (message.type === 'game.sync') {
        this.handleGameSync(socket, connectionId, joinedMember, message);
        return;
      }

      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'unexpected-type');
    });

    socket.on('close', (code, reason) => {
      clearTimeout(handshakeTimer);
      this.clearSocketWatchdog(socket);
      this.openSockets.delete(socket);
      this.logger('ws.disconnected', {
        room: this.roomId,
        conn: connectionId,
        code,
        reason: reason.toString(),
        role: joinedMember?.role,
      });

      if (!joinedMember) {
        return;
      }

      // 若当前席位已被同会话重连的新 socket 替换，旧 close 不能将新连接标为离线
      if (joinedMember.socket !== socket) {
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

  private admitMember(socket: WebSocket, payload: { role: Role; name: string; token?: string; resumeToken?: string }): RoomMember | null {
    if (payload.role === 'host') {
      if (!payload.token || payload.token !== this.hostToken) {
        this.reject(socket, 'host', 'UNAUTHORIZED', 'bad-host-token');
        return null;
      }
      if (this.host && this.lobby.phase === 'started') {
        const member = this.host;
        const oldSocket = member.socket;
        if (oldSocket && oldSocket !== socket) {
          this.clearSocketWatchdog(oldSocket);
          try {
            this.sendError(oldSocket, 'UNAUTHORIZED', 'socket-superseded');
            oldSocket.close(closeCodeForError('UNAUTHORIZED'), 'socket-superseded');
          } catch {
            // ignore
          }
        }
        member.socket = socket;
        member.connected = true;
        member.leaveReason = null;
        if (this.match) {
          const recRes = this.match.clock.onReconnect('host', this.now());
          this.match.revision++;
          if (recRes.settlement) {
            this.match = finalizeMatch(this.match, recRes.settlement.winner, recRes.settlement.reason, this.now());
            this.stopClockBroadcast();
            this.clearClockTimer();
          } else {
            this.scheduleClockDeadline();
          }
          this.broadcastGameState();
        }
        return member;
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
        leaveReason: null,
      };
      this.host = member;
      return member;
    }

    if (payload.resumeToken) {
      if (!this.guestResumeToken || payload.resumeToken !== this.guestResumeToken || !this.guest) {
        this.reject(socket, 'guest', 'UNAUTHORIZED', 'bad-resume-token');
        return null;
      }
      const member = this.guest;
      const oldSocket = member.socket;
      if (oldSocket && oldSocket !== socket) {
        this.clearSocketWatchdog(oldSocket);
        try {
          this.sendError(oldSocket, 'UNAUTHORIZED', 'socket-superseded');
          oldSocket.close(closeCodeForError('UNAUTHORIZED'), 'socket-superseded');
        } catch {
          // 忽略关闭失败
        }
      }
      member.socket = socket;
      member.connected = true;
      member.leaveReason = null;
      if (this.match && this.lobby.phase === 'started') {
        const recRes = this.match.clock.onReconnect('guest', this.now());
        this.match.revision++;
        if (recRes.settlement) {
          this.match = finalizeMatch(this.match, recRes.settlement.winner, recRes.settlement.reason, this.now());
          this.stopClockBroadcast();
          this.clearClockTimer();
        } else {
          this.scheduleClockDeadline();
        }
        this.broadcastGameState();
      }
      return member;
    }

    if (this.guest?.connected) {
      this.reject(socket, 'guest', 'ROOM_FULL', 'guest-slot-taken');
      return null;
    }
    if (this.lobby.phase === 'started' && this.guest) {
      // 开局后保持已冻结身份，不接受新成员替换。
      this.reject(socket, 'guest', 'ROOM_FULL', 'guest-replace-after-start');
      return null;
    }

    this.guestResumeToken = generateToken();
    const member: RoomMember = {
      id: generateId(),
      role: 'guest',
      name: GUEST_NAME,
      socket,
      connected: true,
      leaveReason: null,
    };
    // 只保留一个客人席位：离线客人卡片被新成员替换，不累积幽灵成员。
    if (this.guest) {
      this.applyLobby({ type: 'member-left', role: 'guest' }, socket);
    }
    this.guest = member;
    return member;
  }

  private handleLobbyMessage(
    socket: WebSocket,
    connectionId: string,
    member: RoomMember,
    message: LobbyClientMessage,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    let command: LobbyCommand;
    switch (message.type) {
      case 'lobby.settings':
        command = {
          type: 'update-settings',
          actor: member.role,
          sidePreference: message.payload.sidePreference,
          timeControlId: message.payload.timeControlId,
        };
        break;
      case 'lobby.lock':
        command = { type: 'set-locked', actor: member.role, locked: message.payload.locked };
        break;
      case 'lobby.ready':
        command = {
          type: 'set-ready',
          actor: member.role,
          ready: message.payload.ready,
          settingsVersion: message.payload.settingsVersion,
        };
        break;
      default: {
        const host = this.host;
        const guest = this.guest;
        if (!host || !guest) {
          this.sendLobbyRejection(socket, 'MEMBER_MISSING', 'start-identity');
          return;
        }
        // 随机分先只在真正冻结时抽取一次；重复开始在状态机里先被拒绝，不会再抽。
        const needsDraw = this.lobby.phase === 'lobby' && this.lobby.settings.sidePreference === 'random';
        command = {
          type: 'start',
          actor: member.role,
          roomId: this.roomId,
          host: { memberId: host.id, name: host.name },
          guest: { memberId: guest.id, name: guest.name },
          hostRedWhenRandom: needsDraw ? this.drawHostRed() : null,
        };
        break;
      }
    }

    const result = applyLobbyCommand(this.lobby, command);
    if (!result.ok) {
      this.logger('lobby.rejected', { room: this.roomId, member: member.id, code: result.code, detail: result.detail });
      // 操作拒绝一律非致命：提示原因但保持连接，可继续其他操作。
      this.sendLobbyRejection(socket, result.code, result.detail);
      return;
    }

    if (result.changed) {
      this.lobby = result.state;
      this.logger('lobby.changed', {
        room: this.roomId,
        member: member.id,
        command: command.type,
        phase: result.state.phase,
        settingsVersion: result.state.settings.settingsVersion,
      });
      if (result.state.phase === 'started' && !this.match) {
        const seed = this.drawSeed();
        const matchId = generateId();
        this.match = createMatch({
          matchId,
          seed,
          startParameters: result.state.startParameters!,
          nowFn: this.now,
        });
        this.logger('game.started', { room: this.roomId, matchId, seed });
        this.startClockBroadcast();
        this.scheduleClockDeadline();
      }
      // 发起者同样收到权威状态：既确认操作成功，也清除在途请求。
      this.broadcastLobby();
      if (this.match) {
        this.broadcastGameState();
      }
    }
  }

  private applyLobby(command: LobbyCommand, exclude?: WebSocket): void {
    const result = applyLobbyCommand(this.lobby, command);
    if (result.ok && result.changed) {
      this.lobby = result.state;
      this.broadcastLobby(exclude);
    }
  }

  /** 广播权威大厅快照（welcome 与 lobby.state 携带同一份结构）。 */
  private broadcastLobby(exclude?: WebSocket): void {
    const text = buildServerMessage({
      type: 'lobby.state',
      roomId: this.roomId,
      payload: { lobby: this.getLobby() },
    });
    for (const socket of this.openSockets) {
      if (socket === exclude) {
        continue;
      }
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

  private sendLobbyRejection(socket: WebSocket, code: LobbyRejectCode, detail: string): void {
    try {
      socket.send(
        buildServerMessage({
          type: 'lobby.rejected',
          roomId: this.roomId,
          payload: { code, message: detail },
        }),
      );
    } catch {
      // socket 已关闭。
    }
  }

  private handleMemberDrop(member: RoomMember): void {
    if (this.lobby.phase === 'started' && this.match) {
      const now = this.now();
      const dropRes = this.match.clock.onDrop(member.role, now);
      this.match.revision++;
      if (dropRes.settlement) {
        this.match = finalizeMatch(this.match, dropRes.settlement.winner, dropRes.settlement.reason, now);
        this.stopClockBroadcast();
        this.clearClockTimer();
      } else {
        this.scheduleClockDeadline();
      }
    }

    if (member.role === 'host') {
      if (this.lobby.phase === 'started') {
        if (member.socket) {
          this.clearSocketWatchdog(member.socket);
        }
        member.connected = false;
        member.socket = null;
        member.leaveReason = 'dropped';
        this.logger('ws.host_dropped', { room: this.roomId, member: member.id });
        this.applyLobby({ type: 'member-left', role: 'host' });
        this.broadcastMembers();
        if (this.match) {
          this.broadcastGameState();
        }
        return;
      }
      this.logger('ws.host_dropped', { room: this.roomId, member: member.id });
      void this.closeRoom('host-disconnected');
      return;
    }

    if (member.socket) {
      this.clearSocketWatchdog(member.socket);
    }
    member.connected = false;
    member.socket = null;
    member.leaveReason = 'dropped';
    this.logger('ws.guest_dropped', { room: this.roomId, member: member.id });
    this.applyLobby({ type: 'member-left', role: 'guest' });
    this.broadcastMembers();
    if (this.match) {
      this.broadcastGameState();
    }
  }

  private depart(member: RoomMember, reason: 'leave'): void {
    if (this.lobby.phase === 'started' && this.match) {
      if (member.role === 'guest') {
        const now = this.now();
        const hostSeat = this.match.startParameters.players.find((p) => p.role === 'host')!;
        this.match = finalizeMatch(this.match, hostSeat.side, 'disconnect-timeout', now);
        this.stopClockBroadcast();
        this.clearClockTimer();
        this.broadcastGameState();
      }
    }

    if (member.role === 'host') {
      void this.closeRoom('host-closed');
      return;
    }

    if (member.role === 'guest') {
      this.guestResumeToken = null;
    }

    const socket = member.socket;
    if (socket) {
      this.clearSocketWatchdog(socket);
    }
    member.connected = false;
    member.socket = null;
    member.leaveReason = 'left';
    this.applyLobby({ type: 'member-left', role: 'guest' });
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

  private handleGameAction(
    socket: WebSocket,
    connectionId: string,
    member: RoomMember,
    message: Extract<ClientMessage, { type: 'game.action' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (!this.match || this.lobby.phase !== 'started') {
      this.sendGameRejection(
        socket,
        message.payload.matchId,
        0,
        '对局尚未开始',
        this.match ? snapshotMatch(this.match, this.now()).gameState : createEmptyGameState(),
        message.requestId,
      );
      return;
    }

    // 双方在线检查：避免恢复窗口中的竞争
    if (!this.host?.connected || !this.guest?.connected) {
      this.sendGameRejection(
        socket,
        this.match.matchId,
        this.match.stepNumber,
        '对手已离线，暂无法操作',
        snapshotMatch(this.match, this.now()).gameState,
        message.requestId,
      );
      return;
    }

    if (message.requestId && this.processedActions.has(message.requestId)) {
      const cached = this.processedActions.get(message.requestId)!;
      this.logger('game.action_duplicate', {
        room: this.roomId,
        requestId: message.requestId,
        stepNumber: cached.stepNumber,
      });
      const snap = snapshotMatch(cached.match, this.now());
      try {
        socket.send(
          buildServerMessage({
            type: 'game.state',
            roomId: this.roomId,
            requestId: message.requestId,
            payload: {
              matchId: snap.matchId,
              seed: snap.seed,
              stepNumber: snap.stepNumber,
              revision: snap.revision,
              state: snap.gameState,
              startParameters: snap.startParameters,
              clock: snap.clock,
              ...(snap.settlement ? { settlement: snap.settlement } : {}),
            },
          }),
        );
      } catch {
        // 忽略发送失败
      }
      return;
    }

    if (message.payload.matchId !== this.match.matchId) {
      this.sendGameRejection(
        socket,
        this.match.matchId,
        this.match.stepNumber,
        '对局标识不匹配',
        snapshotMatch(this.match, this.now()).gameState,
        message.requestId,
      );
      return;
    }

    if (message.payload.stepNumber !== this.match.stepNumber) {
      this.sendGameRejection(
        socket,
        this.match.matchId,
        this.match.stepNumber,
        '操作步数已过期，请以最新棋盘为准',
        snapshotMatch(this.match, this.now()).gameState,
        message.requestId,
      );
      return;
    }

    const currentTurn = this.match.gameState.currentTurn;
    const expectedMemberId =
      currentTurn === 'red' ? this.match.startParameters.redMemberId : this.match.startParameters.blackMemberId;

    if (member.id !== expectedMemberId) {
      this.sendGameRejection(
        socket,
        this.match.matchId,
        this.match.stepNumber,
        '非己方回合，请等待对方行动',
        snapshotMatch(this.match, this.now()).gameState,
        message.requestId,
      );
      return;
    }

    const now = this.now();
    const result = applyMatchAction(this.match, member.id, message.payload.action, now);
    if (!result.ok) {
      this.logger('game.action_rejected', {
        room: this.roomId,
        member: member.id,
        reason: result.reason,
      });
      this.sendGameRejection(
        socket,
        this.match.matchId,
        this.match.stepNumber,
        result.reason,
        snapshotMatch(this.match, now).gameState,
        message.requestId,
      );
      return;
    }

    this.match = result.match;
    if (this.match.settlement !== null) {
      this.stopClockBroadcast();
      this.clearClockTimer();
    } else {
      this.scheduleClockDeadline();
    }

    if (message.requestId) {
      this.processedActions.set(message.requestId, {
        stepNumber: this.match.stepNumber,
        match: this.match,
      });
      if (this.processedActions.size > 200) {
        const oldestKey = this.processedActions.keys().next().value;
        if (oldestKey) {
          this.processedActions.delete(oldestKey);
        }
      }
    }

    this.logger('game.action_applied', {
      room: this.roomId,
      matchId: this.match.matchId,
      stepNumber: this.match.stepNumber,
      member: member.id,
    });

    this.broadcastGameState({
      requestId: message.requestId,
      actorMemberId: member.id,
      action: message.payload.action,
    });
  }

  private handleGameSync(
    socket: WebSocket,
    connectionId: string,
    _member: RoomMember,
    message: Extract<ClientMessage, { type: 'game.sync' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }
    if (!this.match || this.lobby.phase !== 'started') {
      this.sendGameRejection(
        socket,
        message.payload.matchId ?? '',
        0,
        '对局尚未开始',
        createEmptyGameState(),
        message.requestId,
      );
      return;
    }
    if (message.payload.matchId && message.payload.matchId !== this.match.matchId) {
      this.sendGameRejection(
        socket,
        message.payload.matchId,
        this.match.stepNumber,
        '对局标识不匹配',
        snapshotMatch(this.match, this.now()).gameState,
        message.requestId,
      );
      return;
    }
    const snap = snapshotMatch(this.match, this.now());
    try {
      socket.send(
        buildServerMessage({
          type: 'game.state',
          roomId: this.roomId,
          ...(message.requestId ? { requestId: message.requestId } : {}),
          payload: {
            matchId: snap.matchId,
            seed: snap.seed,
            stepNumber: snap.stepNumber,
            revision: snap.revision,
            state: snap.gameState,
            startParameters: snap.startParameters,
            clock: snap.clock,
            ...(snap.settlement ? { settlement: snap.settlement } : {}),
          },
        }),
      );
    } catch {
      // 忽略单个发送失败
    }
  }

  private broadcastGameState(options?: {
    requestId?: string;
    actorMemberId?: string;
    action?: MatchAction;
  }): void {
    if (!this.match) {
      return;
    }
    const snap = snapshotMatch(this.match, this.now());
    const text = buildServerMessage({
      type: 'game.state',
      roomId: this.roomId,
      ...(options?.requestId ? { requestId: options.requestId } : {}),
      payload: {
        matchId: snap.matchId,
        seed: snap.seed,
        stepNumber: snap.stepNumber,
        revision: snap.revision,
        state: snap.gameState,
        startParameters: snap.startParameters,
        clock: snap.clock,
        ...(snap.settlement ? { settlement: snap.settlement } : {}),
        ...(options?.actorMemberId ? { actorMemberId: options.actorMemberId } : {}),
        ...(options?.action ? { action: options.action } : {}),
      },
    });

    for (const socket of this.openSockets) {
      if (socket.readyState === 1) {
        try {
          socket.send(text);
        } catch {
          // 忽略发送失败
        }
      }
    }
  }

  private handleLobbyReturn(
    socket: WebSocket,
    connectionId: string,
    member: RoomMember,
    message: Extract<ClientMessage, { type: 'lobby.return' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(socket, connectionId, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    const { matchId, intent } = message.payload;

    if (this.match) {
      if (this.match.matchId !== matchId) {
        this.reject(socket, connectionId, 'INVALID_MESSAGE', 'match-id-mismatch');
        return;
      }

      if (this.match.settlement === null && this.match.gameState.winner === null) {
        this.sendError(socket, 'INVALID_MESSAGE', 'game-not-finished');
        return;
      }

      this.stopClockBroadcast();
      this.clearClockTimer();
      this.match = null;
      this.processedActions.clear();

      this.lobby = {
        ...this.lobby,
        phase: 'lobby',
        startParameters: null,
        ready: {
          host: intent === 'rematch' && member.role === 'host',
          guest: intent === 'rematch' && member.role === 'guest',
        },
      };

      this.logger('game.return_lobby', { room: this.roomId, member: member.id, intent });
      this.broadcastLobby();
      this.broadcastMembers();
      return;
    }

    if (this.lobby.phase === 'lobby') {
      if (intent === 'rematch') {
        if (!this.lobby.ready[member.role]) {
          this.lobby = {
            ...this.lobby,
            ready: {
              ...this.lobby.ready,
              [member.role]: true,
            },
          };
          this.broadcastLobby();
        }
      }
    }
  }

  private sendGameRejection(
    socket: WebSocket,
    matchId: string,
    stepNumber: number,
    reason: string,
    state: GameStateSnapshot,
    requestId?: string,
  ): void {
    try {
      socket.send(
        buildServerMessage({
          type: 'game.rejected',
          roomId: this.roomId,
          ...(requestId ? { requestId } : {}),
          payload: {
            matchId,
            stepNumber,
            reason,
            state,
          },
        }),
      );
    } catch {
      // socket 已关闭
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
