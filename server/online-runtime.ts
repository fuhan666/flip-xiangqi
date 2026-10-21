/**
 * 在线运行时（Online Runtime）：单一 HTTPS/WSS 地址承载多个匿名房间。
 *
 * 一个 Node HTTPS server 同时提供：
 * - 静态页面（构建产物，SPA 深链回退到 index.html）；
 * - `/api/online/*`：匿名会话与建房接口（同源、带 Origin 校验）；
 * - `/ws/rooms/:roomId`：房间 WebSocket，升级前按 cookie 解析身份并绑定目标房间。
 *
 * 这里不代理、也不暴露 LAN 本机控制 API（`/api/room/*`、`/api/guest`）；
 * 每个房间仍是独立的 RoomSession，关闭单房不影响共享监听器与其他房间。
 */
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
} from '../src/network/heartbeat.js';
import type { Logger } from './log.js';
import { defaultLogger } from './log.js';
import {
  AnonymousSessionStore,
  buildAnonymousCookie,
  readCookie,
  ANONYMOUS_COOKIE_NAME,
} from './anonymous-session.js';
import { RoomManager } from './room-manager.js';
import { serveSessionSocket, type SessionSocketHandle } from './session-transport.js';
import { createStaticHandler } from './static.js';
import { RoomSession } from './room-session.js';
import type { RoomIdentity } from './room-identity.js';

export type OnlineRuntimeErrorCode = 'TLS_CONFIG' | 'PUBLIC_ORIGIN' | 'PORT' | 'INTERNAL_ERROR';

export class OnlineRuntimeError extends Error {
  readonly code: OnlineRuntimeErrorCode;

  constructor(code: OnlineRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'OnlineRuntimeError';
    this.code = code;
  }
}

export interface OnlineRuntimeOptions {
  /** 监听端口；0 表示由系统分配（测试用）。 */
  port: number;
  /** 监听地址，默认 0.0.0.0。 */
  host?: string;
  /** TLS 证书与私钥（缺失或解析失败都直接启动失败，绝不回退 HTTP）。 */
  tls: { key: string | Buffer; cert: string | Buffer };
  /** 对外公开来源（必须为 https://），用于同源校验与邀请链接。 */
  publicOrigin: string;
  /** 静态构建产物目录；缺省为 dist。 */
  staticDir?: string;
  logger?: Logger;
  nowFn?: () => number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** 匿名身份存储（测试可注入确定随机源）。 */
  sessionStore?: AnonymousSessionStore;
  /** 房间注册表（测试可注入受控时钟）。 */
  roomManager?: RoomManager;
}

export interface StartedOnlineRuntime {
  port: number;
  publicOrigin: string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4_096;

/** 明确拒绝的 LAN 控制路径：公网入口不代理本机控制 API。 */
const LAN_CONTROL_PATHS = ['/api/room', '/api/guest'];

interface UpgradeTarget {
  roomId: string;
}

function parseUpgradePath(pathname: string): UpgradeTarget | null {
  const match = /^\/ws\/rooms\/([A-Za-z0-9_-]{8,64})$/.exec(pathname);
  if (!match) {
    return null;
  }
  return { roomId: match[1] };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden'}\r\n` +
      'connection: close\r\n' +
      'content-type: text/plain; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class OnlineRuntime {
  private readonly options: OnlineRuntimeOptions;
  private readonly logger: Logger;
  private readonly now: (() => number) | undefined;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly staticHandler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  private readonly sessions: AnonymousSessionStore;
  private readonly rooms: RoomManager;
  private readonly tcpSockets = new Set<Socket>();
  private readonly sockets = new Set<SessionSocketHandle>();
  private closed = false;
  private actualPort = 0;

  constructor(options: OnlineRuntimeOptions) {
    if (!options.tls || !options.tls.key || !options.tls.cert) {
      throw new OnlineRuntimeError('TLS_CONFIG', '在线入口必须提供 TLS 证书与私钥，不能以 HTTP 启动');
    }
    let origin: URL;
    try {
      origin = new URL(options.publicOrigin);
    } catch {
      throw new OnlineRuntimeError('PUBLIC_ORIGIN', `无法解析公开地址「${options.publicOrigin}」`);
    }
    if (origin.protocol !== 'https:') {
      throw new OnlineRuntimeError('PUBLIC_ORIGIN', '在线入口的公开地址必须是 https://');
    }

    this.options = options;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.nowFn;
    this.sessions = options.sessionStore ?? new AnonymousSessionStore();
    this.rooms =
      options.roomManager ??
      new RoomManager({
        logger: this.logger,
        createSession: (sessionOptions) =>
          new RoomSession({
            roomId: sessionOptions.roomId,
            mode: 'online',
            ownerIdentityId: sessionOptions.ownerIdentityId,
            logger: this.logger,
            ...(this.now ? { nowFn: this.now } : {}),
            onClose: (reason) => {
              this.rooms.closeRoom(sessionOptions.roomId, reason);
            },
          }),
      });

    try {
      this.server = createServer({ key: options.tls.key, cert: options.tls.cert }, (request, response) => {
        void this.handleRequest(request, response);
      });
    } catch (error) {
      throw new OnlineRuntimeError('TLS_CONFIG', `TLS 证书或私钥无效：${(error as Error).message}`);
    }

    this.staticHandler = createStaticHandler(options.staticDir ?? 'dist');
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('connection', (rawSocket) => {
      const socket = rawSocket as unknown as Socket;
      this.tcpSockets.add(socket);
      socket.on('close', () => this.tcpSockets.delete(socket));
    });
    this.server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket as unknown as Socket, head);
    });
  }

  get port(): number {
    return this.actualPort;
  }

  /** 对外公开来源（与 Origin 校验使用同一个值）。 */
  get publicOrigin(): string {
    return this.options.publicOrigin;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get roomCount(): number {
    return this.rooms.roomCount;
  }

  /** 只读获取房间会话（观测/测试用；写入仍只经 WebSocket 协议）。 */
  getRoom(roomId: string): RoomSession | null {
    return this.rooms.get(roomId);
  }

  start(): Promise<StartedOnlineRuntime> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          reject(new OnlineRuntimeError('PORT', `端口 ${this.options.port} 已被占用`));
          return;
        }
        reject(new OnlineRuntimeError('INTERNAL_ERROR', `在线入口启动失败：${error.message}`));
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        const address = this.server.address();
        this.actualPort = typeof address === 'object' && address ? address.port : this.options.port;
        this.logger('online.listening', { port: this.actualPort, origin: this.options.publicOrigin });
        resolve({ port: this.actualPort, publicOrigin: this.options.publicOrigin });
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.options.port, this.options.host ?? '0.0.0.0');
    });
  }

  /** 停止服务（幂等）：关闭全部房间与连接、释放监听器与匿名凭据。 */
  async stop(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.rooms.stop();
    for (const handle of [...this.sockets]) {
      handle.dispose(1001, 'server-stopped');
    }
    this.sockets.clear();
    this.sessions.clear();

    for (const socket of this.tcpSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    this.logger('online.stopped', { port: this.actualPort });
  }

  private isSameOrigin(headers: IncomingHttpHeaders): boolean {
    return headers.origin === this.options.publicOrigin;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'https://online.local');
    const pathname = url.pathname;

    if (LAN_CONTROL_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      sendJson(response, 404, { ok: false, code: 'LAN_CONTROL_UNAVAILABLE', message: '在线入口不提供本机控制接口' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      await this.handleApi(request, response, pathname);
      return;
    }

    if (this.closed) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('服务已停止');
      return;
    }

    if (pathname === '/') {
      response.writeHead(302, { location: '/online' });
      response.end();
      return;
    }

    await this.staticHandler(request, response);
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    // 写操作与身份接口一律要求同源：不信任 Host / 转发头，不放开通配 CORS。
    if (request.method !== 'GET' && !this.isSameOrigin(request.headers)) {
      sendJson(response, 403, { ok: false, code: 'BAD_ORIGIN', message: '请求来源不可信' });
      return;
    }

    if (pathname === '/api/online/session') {
      if (request.method === 'POST') {
        await this.handleSessionCreate(request, response);
        return;
      }
      if (request.method === 'GET') {
        const identity = this.resolveIdentity(request.headers);
        if (!identity) {
          sendJson(response, 401, { ok: false, code: 'SESSION_INVALID' });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
      return;
    }

    if (pathname === '/api/online/rooms') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
        return;
      }
      await this.handleRoomCreate(request, response);
      return;
    }

    const closeMatch = /^\/api\/online\/rooms\/([A-Za-z0-9_-]{8,64})\/close$/.exec(pathname);
    if (closeMatch) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const identity = this.resolveIdentity(request.headers);
      if (!identity) {
        sendJson(response, 401, { ok: false, code: 'SESSION_INVALID' });
        return;
      }
      const closed = this.rooms.closeOwnRoom(closeMatch[1]!, identity.identityId);
      sendJson(response, closed ? 200 : 403, { ok: closed });
      return;
    }

    const roomMatch = /^\/api\/online\/rooms\/([A-Za-z0-9_-]{8,64})$/.exec(pathname);
    if (roomMatch && request.method === 'GET') {
      const session = this.rooms.get(roomMatch[1]!);
      if (!session) {
        sendJson(response, 404, { ok: false, code: 'ROOM_UNAVAILABLE' });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        roomId: session.roomId,
        phase: session.getLobbyPhase(),
        members: session.getMembers().map((member) => ({ role: member.role, connected: member.connected })),
      });
      return;
    }

    sendJson(response, 404, { ok: false, code: 'NOT_FOUND' });
  }

  private async handleSessionCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (body === null) {
      sendJson(response, 400, { ok: false, code: 'INVALID_BODY' });
      return;
    }
    const reset = body.reset === true;
    const token = readCookie(request.headers.cookie, ANONYMOUS_COOKIE_NAME);

    if (reset) {
      this.sessions.revoke(token);
      const issued = this.sessions.issue();
      response.setHeader('set-cookie', buildAnonymousCookie(issued.token));
      sendJson(response, 200, { ok: true, reset: true });
      return;
    }

    if (token !== null) {
      const identity = this.sessions.resolve(token);
      if (!identity) {
        // 伪造或进程重启后失效：明确 401，绝不静默发放新身份替代原席位。
        sendJson(response, 401, { ok: false, code: 'SESSION_INVALID', message: '匿名会话已失效' });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    const issued = this.sessions.issue();
    response.setHeader('set-cookie', buildAnonymousCookie(issued.token));
    sendJson(response, 200, { ok: true, created: true });
  }

  private async handleRoomCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const identity = this.resolveIdentity(request.headers);
    if (!identity) {
      sendJson(response, 401, { ok: false, code: 'SESSION_INVALID' });
      return;
    }
    const body = await readJsonBody(request);
    if (body === null || typeof body.requestId !== 'string' || body.requestId.length === 0) {
      sendJson(response, 400, { ok: false, code: 'INVALID_REQUEST_ID' });
      return;
    }
    if (body.requestId.length > 128) {
      sendJson(response, 400, { ok: false, code: 'INVALID_REQUEST_ID' });
      return;
    }

    try {
      const result = this.rooms.createRoom({
        identityId: identity.identityId,
        requestId: body.requestId,
      });
      if (!result.ok) {
        sendJson(response, 409, { ok: false, code: result.code, message: result.message });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        roomId: result.roomId,
        url: `${this.options.publicOrigin}/online/rooms/${result.roomId}`,
        created: result.created,
        closed: result.closed,
      });
    } catch (error) {
      this.logger('online.create_failed', { detail: (error as Error).message });
      sendJson(response, 500, { ok: false, code: 'INTERNAL_ERROR' });
    }
  }

  private resolveIdentity(headers: IncomingHttpHeaders): RoomIdentity | null {
    const token = readCookie(headers.cookie, ANONYMOUS_COOKIE_NAME);
    return this.sessions.resolve(token);
  }

  private async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'https://online.local').pathname;
    const target = parseUpgradePath(pathname);
    if (!target) {
      rejectUpgrade(socket, 404, 'not-found');
      return;
    }
    if (this.closed) {
      rejectUpgrade(socket, 403, 'service-stopped');
      return;
    }
    if (!this.isSameOrigin(request.headers)) {
      rejectUpgrade(socket, 403, 'bad-origin');
      return;
    }
    const identity = this.resolveIdentity(request.headers);
    if (!identity) {
      rejectUpgrade(socket, 401, 'invalid-session');
      return;
    }
    const session = this.rooms.get(target.roomId);
    if (!session) {
      rejectUpgrade(socket, 404, 'room-unavailable');
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
      // 连接在升级时即绑定该房间：后续消息只能作用于这个房间。
      const handle = serveSessionSocket({
        session,
        socket: webSocket,
        logger: this.logger,
        now: this.now ?? (() => Date.now()),
        handshakeTimeoutMs: this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
        admission: { identity },
        onClosed: () => {
          this.sockets.delete(handle);
        },
      });
      this.sockets.add(handle);
    });
  }
}
