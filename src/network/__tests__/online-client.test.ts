// @vitest-environment node
/**
 * 在线客户端：同源房间 URL、online.hello 载荷与重连行为。
 * 这里用明文 ws 传输验证客户端逻辑；TLS/Origin/cookie 由服务端集成测试覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { RoomClient, type WebSocketLike } from '../client';
import { createLobbyState } from '../lobby';
import { buildServerMessage, PROTOCOL_VERSION } from '../protocol';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface TestServer {
  wss: WebSocketServer;
  port: number;
  received: Record<string, any>[];
}

async function startServer(path: string): Promise<TestServer> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const received: Record<string, any>[] = [];
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.type === 'online.hello') {
        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: message.roomId,
            payload: {
              roomId: message.roomId,
              memberId: 'member-1',
              role: 'host',
              name: '房主',
              members: [{ id: 'member-1', role: 'host', name: '房主', connected: true }],
              lobby: createLobbyState(),
            },
          }),
        );
      }
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  );
  return { wss, port, received };
}

function makeClient(port: number): RoomClient {
  const client = new RoomClient({
    onlineOrigin: `http://127.0.0.1:${port}`,
    webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
    connectTimeoutMs: 2_000,
    reconnectDelays: [10],
    reconnectBudgetMs: 2_000,
    heartbeatIntervalMs: 60_000,
  });
  cleanups.push(() => client.disconnect(false));
  return client;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for client state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('RoomClient 在线接入', () => {
  it('按同源来源构造 wss/ws 房间地址并在握手时只发送房间号', async () => {
    const server = await startServer('/ws/rooms/room-online');
    const client = makeClient(server.port);

    client.connectOnline('room-online');
    await waitUntil(() => client.getState().status === 'connected');

    const hello = server.received.find((message) => message.type === 'online.hello');
    expect(hello).toBeDefined();
    expect(hello!.version).toBe(PROTOCOL_VERSION);
    expect(hello!.roomId).toBe('room-online');
    expect(hello!.payload).toEqual({});
    expect(Object.keys(hello!.payload)).toHaveLength(0);
    expect(hello!.roomId).not.toBe('');

    expect(client.getAddress()).toBe(`ws://127.0.0.1:${server.port}/ws/rooms/room-online`);
    expect(client.getState()).toMatchObject({ roomId: 'room-online', memberId: 'member-1', role: 'host' });
  });

  it('掉线后凭同一 cookie 自动重连，仍然只发 online.hello（不依赖实例内恢复密钥）', async () => {
    const server = await startServer('/ws/rooms/room-reconnect');
    const client = makeClient(server.port);

    client.connectOnline('room-reconnect');
    await waitUntil(() => client.getState().status === 'connected');
    expect(server.received.filter((message) => message.type === 'online.hello')).toHaveLength(1);

    // 服务端断开一条连接：客户端应自动重连并重新握手。
    for (const socket of server.wss.clients) {
      socket.terminate();
    }
    await waitUntil(() => client.getState().status === 'reconnecting' || client.getState().status === 'connected');
    await waitUntil(() => server.received.filter((message) => message.type === 'online.hello').length === 2, 4_000);
    await waitUntil(() => client.getState().status === 'connected', 4_000);

    const hellos = server.received.filter((message) => message.type === 'online.hello');
    expect(hellos.every((hello) => hello.roomId === 'room-reconnect')).toBe(true);
    expect(hellos.every((hello) => hello.payload && Object.keys(hello.payload).length === 0)).toBe(true);
    expect(server.received.some((message) => message.type === 'hello')).toBe(false);
  });

  it('刷新式释放传输不发送 leave，显式退出才通知服务器', async () => {
    const server = await startServer('/ws/rooms/room-leave');

    const passive = makeClient(server.port);
    passive.connectOnline('room-leave');
    await waitUntil(() => passive.getState().status === 'connected');
    passive.disconnect(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.received.some((message) => message.type === 'leave')).toBe(false);

    const active = makeClient(server.port);
    active.connectOnline('room-leave');
    await waitUntil(() => active.getState().status === 'connected');
    active.disconnect(true);
    await waitUntil(() => server.received.some((message) => message.type === 'leave'));
    const leave = server.received.find((message) => message.type === 'leave');
    expect(leave!.roomId).toBe('room-leave');
  });
});
