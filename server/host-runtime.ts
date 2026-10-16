/**
 * 本机宿主运行时：
 * - loopback 控制台端口：提供本机 UI 与房间控制 API（建房/关房），只接受本机来源；
 * - 局域网房间端口（按需启动）：提供客人页面与 /ws 连接层，绝不暴露控制 API 或房主凭据。
 *
 * 开发形态页面由 Vite middleware 提供（保留热更新），生产形态直接服务 dist/ 静态产物。
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { defaultLogger, type Logger } from './log.js';
import { listLanAddresses, type LanAddress } from './network-addresses.js';
import { RoomServerError, RoomServer, type StartedRoom } from './room-server.js';
import { createStaticHandler } from './static.js';

export type PageHandler = (request: IncomingMessage, response: ServerResponse, next?: (error?: unknown) => void) => void;

export interface HostRuntimeOptions {
  /** 控制台 UI 端口（仅 loopback）。 */
  uiPort: number;
  /** 建房默认端口（局域网监听，占用自动顺延）。 */
  roomPort: number;
  dev: boolean;
  /** 生产形态的静态产物目录。 */
  staticDir?: string;
  maxPortAttempts?: number;
  handshakeTimeoutMs?: number;
  logger?: Logger;
}

export interface RoomInfoPayload {
  roomId: string;
  port: number;
  addresses: LanAddress[];
  loopbackOnly: boolean;
}

interface ApiResponse {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

const MAX_BODY_BYTES = 16 * 1024;

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  const address = remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function tokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('body-too-large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body-not-object');
  }
  return parsed as Record<string, unknown>;
}

export class HostRuntime {
  private readonly options: HostRuntimeOptions;
  private readonly logger: Logger;
  private readonly tcpSockets = new Set<Socket>();
  private controlServer: Server | null = null;
  private pageHandler: PageHandler;
  private vite: { middlewares: PageHandler; close(): Promise<void> } | null = null;
  private room: StartedRoom | null = null;

  constructor(options: HostRuntimeOptions) {
    this.options = options;
    this.logger = options.logger ?? defaultLogger;
    this.pageHandler = () => {
      throw new Error('page handler not initialized');
    };
  }

  async start(): Promise<number> {
    if (this.options.dev) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      this.vite = vite;
      this.pageHandler = (request, response, next) => {
        void vite.middlewares(request, response, next ?? (() => undefined));
      };
    } else {
      const staticHandler = createStaticHandler(path.resolve(this.options.staticDir ?? 'dist'));
      this.pageHandler = (request, response) => {
        void staticHandler(request, response);
      };
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on('connection', (socket) => {
      this.tcpSockets.add(socket);
      socket.on('close', () => this.tcpSockets.delete(socket));
    });

    this.controlServer = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.uiPort, '127.0.0.1');
    });

    this.logger('host.listening', { port: this.options.uiPort, mode: this.options.dev ? 'dev' : 'production' });
    return this.options.uiPort;
  }

  getRoomInfo(): RoomInfoPayload | null {
    if (!this.room) {
      return null;
    }
    return this.buildRoomInfo(this.room);
  }

  getDefaultRoomPort(): number {
    return this.options.roomPort;
  }

  /** 建房：已有活动房间时返回同一房间（重复点击不产生第二个监听器）。 */
  async createRoom(preferredPort?: number): Promise<ApiResponse> {
    if (this.room && !this.room.server.isClosed) {
      this.logger('room.create_duplicate', { room: this.room.roomId, port: this.room.port });
      return { ok: true, ...this.buildRoomInfo(this.room), hostToken: this.room.hostToken };
    }

    const port = preferredPort ?? this.options.roomPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, code: 'INVALID_PORT', message: `端口 ${port} 无效，请在设置中改为 1-65535 之间的整数` };
    }

    const roomServer = new RoomServer({
      preferredPort: port,
      maxPortAttempts: this.options.maxPortAttempts,
      handshakeTimeoutMs: this.options.handshakeTimeoutMs,
      logger: this.logger,
      requestListener: (request, response) => {
        void this.handleRoomPageRequest(request, response);
      },
    });

    try {
      const actualPort = await roomServer.start();
      const started: StartedRoom = {
        server: roomServer,
        roomId: roomServer.roomId,
        hostToken: roomServer.hostToken,
        port: actualPort,
      };
      this.room = started;
      this.logger('room.created', { room: started.roomId, port: started.port });
      return { ok: true, ...this.buildRoomInfo(started), hostToken: started.hostToken };
    } catch (error) {
      if (error instanceof RoomServerError) {
        this.logger('room.create_failed', { code: error.code });
        return { ok: false, code: error.code, message: error.message };
      }
      this.logger('room.create_failed', { code: 'INTERNAL_ERROR' });
      return { ok: false, code: 'INTERNAL_ERROR', message: `房间服务启动失败：${(error as Error).message}` };
    }
  }

  async closeRoom(hostToken: string): Promise<ApiResponse> {
    if (!this.room || this.room.server.isClosed) {
      this.room = null;
      return { ok: false, code: 'ROOM_CLOSED', message: '房间已关闭或人数已满 —— 当前没有进行中的房间 —— 请重新创建房间' };
    }
    if (!tokensMatch(hostToken, this.room.hostToken)) {
      this.logger('room.close_rejected', { room: this.room.roomId, code: 'UNAUTHORIZED' });
      return { ok: false, code: 'UNAUTHORIZED', message: '关闭房间需要房主本人操作 —— 凭据校验未通过 —— 请在房主电脑上重试' };
    }

    const room = this.room;
    this.room = null;
    await room.server.closeRoom('host-closed');
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (this.room) {
      const room = this.room;
      this.room = null;
      await room.server.closeRoom('server-stopped');
    }

    if (this.controlServer) {
      const server = this.controlServer;
      this.controlServer = null;
      for (const socket of this.tcpSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (this.vite) {
      const vite = this.vite;
      this.vite = null;
      await vite.close();
    }
    this.logger('host.stopped', {});
  }

  private buildRoomInfo(room: StartedRoom): RoomInfoPayload {
    const addresses = listLanAddresses();
    return {
      roomId: room.roomId,
      port: room.port,
      addresses,
      loopbackOnly: addresses.length === 0,
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://control.local').pathname;

    if (!pathname.startsWith('/api/')) {
      this.pageHandler(request, response, () => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
      });
      return;
    }

    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      this.sendJson(response, 403, { ok: false, code: 'FORBIDDEN', message: '控制接口仅允许本机访问' });
      return;
    }

    if (pathname === '/api/guest') {
      // 控制台页面不是房间页面：以 ok:false 应答（404 会被浏览器计入控制台错误），
      // 供前端区分「本机 UI」与「房间客人页面」。
      this.sendJson(response, 200, { ok: false, roomPage: false });
      return;
    }

    if (pathname === '/api/room/status' && request.method === 'GET') {
      const room = this.room && !this.room.server.isClosed ? this.buildRoomInfo(this.room) : null;
      this.sendJson(response, 200, {
        ok: true,
        hostAvailable: true,
        defaultRoomPort: this.options.roomPort,
        active: room !== null,
        room,
      });
      return;
    }

    if (pathname === '/api/room/create' && request.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch {
        this.sendJson(response, 400, { ok: false, code: 'BAD_REQUEST', message: '请求内容无法解析' });
        return;
      }
      const requestedPort = body.port;
      if (requestedPort !== undefined && typeof requestedPort !== 'number') {
        this.sendJson(response, 400, { ok: false, code: 'INVALID_PORT', message: '端口必须是数字' });
        return;
      }
      const result = await this.createRoom(typeof requestedPort === 'number' ? requestedPort : undefined);
      this.sendJson(response, result.ok ? 200 : 500, result);
      return;
    }

    if (pathname === '/api/room/close' && request.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch {
        this.sendJson(response, 400, { ok: false, code: 'BAD_REQUEST', message: '请求内容无法解析' });
        return;
      }
      const hostToken = body.hostToken;
      if (typeof hostToken !== 'string' || hostToken.length === 0) {
        this.sendJson(response, 400, { ok: false, code: 'UNAUTHORIZED', message: '缺少房主凭据' });
        return;
      }
      const result = await this.closeRoom(hostToken);
      this.sendJson(response, result.ok ? 200 : 500, result);
      return;
    }

    this.sendJson(response, 404, { ok: false, code: 'NOT_FOUND', message: '接口不存在' });
  }

  private async handleRoomPageRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://room.local').pathname;
    if (pathname === '/api/guest') {
      // 房间页面标记：公开且不含任何凭据，供页面识别「我正打开房主分享的地址」。
      this.sendJson(response, 200, { ok: true, roomPage: true });
      return;
    }
    if (pathname === '/api/room/status' && request.method === 'GET') {
      // 房间页面不提供控制接口：以 ok:false 应答宿主探测，避免浏览器把 404 计入控制台错误。
      this.sendJson(response, 200, { ok: false, hostAvailable: false, roomPage: true });
      return;
    }
    if (pathname.startsWith('/api/')) {
      this.sendJson(response, 404, { ok: false, code: 'NOT_FOUND', message: '房间页面不提供控制接口' });
      return;
    }
    this.pageHandler(request, response, () => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
    });
  }

  private sendJson(response: ServerResponse, status: number, body: ApiResponse): void {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(text);
  }
}
