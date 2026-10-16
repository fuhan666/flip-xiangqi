// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { RoomClient, type WebSocketLike } from '../client';
import { buildServerMessage, closeCodeForError, PROTOCOL_VERSION } from '../protocol';

interface TestServer {
  wss: WebSocketServer;
  port: number;
}

const cleanupQueue: Array<() => Promise<void>> = [];

async function startServer(onConnection: (socket: NodeWebSocket) => void): Promise<TestServer> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', onConnection);
  const port = (wss.address() as AddressInfo).port;
  cleanupQueue.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  );
  return { wss, port };
}

function makeClient(connectTimeoutMs = 2000): RoomClient {
  return new RoomClient({
    webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
    connectTimeoutMs,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for client state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const members = [{ id: 'guest-1', role: 'guest' as const, name: '客人', connected: true }];

afterEach(async () => {
  while (cleanupQueue.length > 0) {
    await cleanupQueue.pop()?.();
  }
});

describe('RoomClient', () => {
  it('completes the handshake and exposes the member snapshot', async () => {
    const server = await startServer((socket) => {
      socket.on('message', (data) => {
        const hello = JSON.parse(data.toString());
        expect(hello.type).toBe('hello');
        expect(hello.version).toBe(PROTOCOL_VERSION);
        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: 'room-1',
            payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members },
          }),
        );
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'connected');
    expect(client.getState()).toMatchObject({
      status: 'connected',
      roomId: 'room-1',
      memberId: 'guest-1',
      role: 'guest',
      members,
    });
    expect(client.getAddress()).toBe(`127.0.0.1:${server.port}`);
  });

  it('times out with CONNECT_TIMEOUT when the server never welcomes the client', async () => {
    const server = await startServer(() => {
      // 接受连接但不完成握手。
    });

    const client = makeClient(120);
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'error');
    expect(client.getState().errorCode).toBe('CONNECT_TIMEOUT');
    expect(client.getState().message).toContain('连接超时');
  });

  it('maps protocol rejections to their error code and copy', async () => {
    const server = await startServer((socket) => {
      socket.on('message', () => {
        socket.send(
          buildServerMessage({
            type: 'error',
            roomId: 'room-1',
            payload: { code: 'VERSION_MISMATCH', message: 'version' },
          }),
        );
        socket.close(closeCodeForError('VERSION_MISMATCH'), 'VERSION_MISMATCH');
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'error');
    expect(client.getState().errorCode).toBe('VERSION_MISMATCH');
    expect(client.getState().message).toContain('版本不一致');
  });

  it('reports a generic failure when the connection drops before the handshake', async () => {
    const server = await startServer((socket) => {
      socket.terminate();
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'error');
    expect(client.getState().errorCode).toBe('CONNECT_FAILED');
  });

  it('ignores stale socket callbacks after a newer connect attempt wins', async () => {
    const slowServer = await startServer(() => {
      // 永不回应第一台服务端。
    });
    const fastServer = await startServer((socket) => {
      socket.on('message', () => {
        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: 'room-fast',
            payload: { roomId: 'room-fast', memberId: 'guest-1', role: 'guest', name: '客人', members },
          }),
        );
      });
    });

    const client = makeClient(200);
    client.connect({ host: '127.0.0.1', port: slowServer.port }, { role: 'guest', name: '客人' });
    client.connect({ host: '127.0.0.1', port: fastServer.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'connected');
    expect(client.getState().roomId).toBe('room-fast');

    // 旧连接的超时/关闭回调不允许覆盖新状态。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.getState().status).toBe('connected');
    expect(client.getState().roomId).toBe('room-fast');
  });

  it('handles room.closed by surfacing the reason and staying disconnected', async () => {
    const server = await startServer((socket) => {
      socket.on('message', () => {
        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: 'room-1',
            payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members },
          }),
        );
        socket.send(
          buildServerMessage({
            type: 'room.closed',
            roomId: 'room-1',
            payload: { reason: 'host-closed' },
          }),
        );
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'disconnected');
    expect(client.getState().closedReason).toBe('host-closed');
    expect(client.getState().message).toContain('房主已关闭房间');
  });

  it('sends a leave message on disconnect and resets to idle disconnected state', async () => {
    let receivedLeave: Record<string, unknown> | null = null;
    const server = await startServer((socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'hello') {
          socket.send(
            buildServerMessage({
              type: 'welcome',
              roomId: 'room-1',
              payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members },
            }),
          );
        }
        if (message.type === 'leave') {
          receivedLeave = message;
        }
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });
    await waitUntil(() => client.getState().status === 'connected');

    client.disconnect();
    await waitUntil(() => receivedLeave !== null);
    expect(receivedLeave).toMatchObject({ type: 'leave', roomId: 'room-1' });
    expect(client.getState().status).toBe('disconnected');
    expect(client.getState().roomId).toBeNull();
  });

  it('rejects a second connect while already connected', async () => {
    const server = await startServer((socket) => {
      socket.on('message', () => {
        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: 'room-1',
            payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members },
          }),
        );
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });
    await waitUntil(() => client.getState().status === 'connected');

    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });
    expect(client.getState().status).toBe('error');
    expect(client.getState().errorCode).toBe('ALREADY_CONNECTED');
  });
});
