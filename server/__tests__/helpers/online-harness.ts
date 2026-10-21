/**
 * 在线入口集成测试工具：真实 HTTPS 请求、真实 WSS 客户端与独立 cookie jar。
 * 证书来自测试专用自签文件，客户端显式信任该证书（不关闭 TLS 校验）。
 */
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { WebSocketLike } from '../../../src/network/client';
import { OnlineRuntime } from '../../online-runtime';
import { testTls } from './tls';

/** 测试用对外来源：主机固定 127.0.0.1，端口随监听端口一致。 */
export function originFor(port: number): string {
  return `https://127.0.0.1:${port}`;
}

export async function until(predicate: () => boolean, timeout = 4_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('state did not converge before deadline');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 预留一个空闲端口，保证 publicOrigin 与实际监听端口一致。 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export async function startOnlineRuntime(): Promise<OnlineRuntime> {
  const port = await freePort();
  const runtime = new OnlineRuntime({
    port,
    host: '127.0.0.1',
    publicOrigin: originFor(port),
    staticDir: 'dist',
    tls: testTls(),
    logger: () => undefined,
    handshakeTimeoutMs: 2_000,
    heartbeatIntervalMs: 2_000,
    heartbeatTimeoutMs: 4_000,
  });
  await runtime.start();
  return runtime;
}

export interface ApiResponse {
  status: number;
  json: Record<string, any> | null;
  setCookie: string | null;
}

export interface ApiRequest {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  cookie?: string | null;
  origin?: string | null;
}

/** 直接走 HTTPS 的真实请求：默认带同源 Origin，可显式覆盖或去掉。 */
export function callApi(port: number, path: string, request: ApiRequest = {}): Promise<ApiResponse> {
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
  const method = request.method ?? (payload === undefined ? 'GET' : 'POST');
  const origin = request.origin === undefined ? originFor(port) : request.origin;
  const headers: Record<string, string | number> = {};
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(payload);
  }
  if (origin !== null) {
    headers.origin = origin;
  }
  if (request.cookie) {
    headers.cookie = request.cookie;
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path, method, headers, ca: testTls().cert },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, any> | null = null;
          try {
            const parsed: unknown = JSON.parse(text);
            json = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, any>) : null;
          } catch {
            json = null;
          }
          const rawCookie = response.headers['set-cookie'];
          resolve({
            status: response.statusCode ?? 0,
            json,
            setCookie: Array.isArray(rawCookie) ? rawCookie[0] ?? null : rawCookie ?? null,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

/** 建立一次匿名会话，返回可直接作为 Cookie 头使用的值。 */
export async function openSession(port: number): Promise<string> {
  const response = await callApi(port, '/api/online/session', { body: {} });
  if (response.status !== 200 || !response.setCookie) {
    throw new Error(`匿名会话建立失败：${response.status}`);
  }
  return response.setCookie.split(';')[0]!;
}

export async function createRoom(port: number, cookie: string, requestId: string) {
  return callApi(port, '/api/online/rooms', { body: { requestId }, cookie });
}

export interface TrafficEntry {
  direction: 'in' | 'out';
  message: Record<string, any>;
}

/** 在线客户端 socket 工厂：携带本人 cookie、同源 Origin，并记录全部出入站消息。 */
export function onlineSocketFactory(cookie: string, traffic: TrafficEntry[], origin: string) {
  return (url: string): WebSocketLike => {
    const socket = new WebSocket(url, {
      ca: testTls().cert,
      origin,
      headers: { cookie },
    });
    const facade: WebSocketLike = {
      get readyState() {
        return socket.readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (raw: string) => {
        traffic.push({ direction: 'out', message: JSON.parse(raw) });
        if (socket.readyState === 1) {
          socket.send(raw);
        }
      },
      close: (code?: number, reason?: string) => socket.close(code, reason),
    };
    socket.on('open', () => facade.onopen?.({}));
    socket.on('message', (raw) => {
      const text = raw.toString();
      traffic.push({ direction: 'in', message: JSON.parse(text) });
      facade.onmessage?.({ data: text });
    });
    socket.on('close', (code) => facade.onclose?.({ code }));
    socket.on('error', (error) => facade.onerror?.(error));
    return facade;
  };
}

interface RawOpenOptions {
  cookie?: string | null;
  origin?: string | null;
}

/** 原始 WSS 客户端：用于断言握手拒绝、非法载荷与跨房请求的真实返回。 */
export class RawRoomSocket {
  readonly messages: Record<string, any>[] = [];
  closed: { code: number; reason: string } | null = null;

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => this.messages.push(JSON.parse(raw.toString())));
    socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  static open(port: number, roomId: string, options: RawOpenOptions = {}): Promise<RawRoomSocket> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.cookie) {
        headers.cookie = options.cookie;
      }
      const socket = new WebSocket(`wss://127.0.0.1:${port}/ws/rooms/${roomId}`, {
        ca: testTls().cert,
        rejectUnauthorized: true,
        origin: options.origin === undefined ? originFor(port) : (options.origin ?? undefined),
        headers,
      });
      const cleanup = () => {
        socket.removeListener('open', onOpen);
        socket.removeListener('unexpected-response', onResponse);
        socket.removeListener('error', onError);
      };
      const onOpen = () => {
        cleanup();
        resolve(new RawRoomSocket(socket));
      };
      const onResponse = (_request: unknown, response: { statusCode?: number; destroy: () => void }) => {
        cleanup();
        response.destroy();
        reject(new Error(`upgrade-rejected:${response.statusCode ?? 0}`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once('open', onOpen);
      socket.once('unexpected-response', onResponse);
      socket.once('error', onError);
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  last(type: string): Record<string, any> | null {
    const matches = this.messages.filter((message) => message.type === type);
    return matches.length > 0 ? matches[matches.length - 1]! : null;
  }

  close(): void {
    this.socket.close();
  }
}

/** 递归收集消息里出现过的字段名，用于断言没有密钥泄漏。 */
export function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, into);
    }
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(item, into);
    }
  }
  return into;
}
