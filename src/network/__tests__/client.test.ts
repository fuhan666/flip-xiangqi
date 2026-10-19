// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { RoomClient, type WebSocketLike } from '../client';
import { applyLobbyCommand, buildStartParameters, createLobbyState, type LobbyState } from '../lobby';
import { createMatch, snapshotMatch } from '../match';
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
            payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members, lobby: createLobbyState() },
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
            payload: { roomId: 'room-fast', memberId: 'guest-1', role: 'guest', name: '客人', members, lobby: createLobbyState() },
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
            payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members, lobby: createLobbyState() },
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
              payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members, lobby: createLobbyState() },
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
            payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members, lobby: createLobbyState() },
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

  it('tracks lobby snapshots from welcome and lobby.state broadcasts', async () => {
    const sockets: NodeWebSocket[] = [];
    const server = await startServer((socket) => {
      sockets.push(socket);
      socket.on('message', () => {
        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: 'room-1',
            payload: { roomId: 'room-1', memberId: 'guest-1', role: 'guest', name: '客人', members, lobby: createLobbyState() },
          }),
        );
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });
    await waitUntil(() => client.getState().status === 'connected');
    expect(client.getState().lobby).toMatchObject({ phase: 'lobby', settings: { settingsVersion: 1 }, startParameters: null });

    const next = applyLobbyCommand(client.getState().lobby as LobbyState, {
      type: 'update-settings',
      actor: 'host',
      sidePreference: 'host-black',
      timeControlId: 'standard',
    });
    if (!next.ok) {
      throw new Error('fixture change failed');
    }
    sockets[0]?.send(
      buildServerMessage({ type: 'lobby.state', roomId: 'room-1', payload: { lobby: next.state } }),
    );

    await waitUntil(() => client.getState().lobby?.settings.sidePreference === 'host-black');
    expect(client.getState().lobby).toMatchObject({ settings: { timeControlId: 'standard', settingsVersion: 2 } });
  });

  it('sends lobby requests bound to the room and clears the pending command on the answer', async () => {
    const received: Array<Record<string, any>> = [];
    const sockets: NodeWebSocket[] = [];
    const server = await startServer((socket) => {
      sockets.push(socket);
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'hello') {
          socket.send(
            buildServerMessage({
              type: 'welcome',
              roomId: 'room-1',
              payload: { roomId: 'room-1', memberId: 'host-1', role: 'host', name: '房主', members, lobby: createLobbyState() },
            }),
          );
          return;
        }
        received.push(message);
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'host', name: '房主', token: 't' });
    await waitUntil(() => client.getState().status === 'connected');

    client.sendLobbySettings('host-red', 'standard');
    expect(client.getState().pendingCommand).toBe('settings');
    client.sendLobbyLock(true);
    client.sendLobbyReady(true);
    client.sendLobbyStart();
    expect(client.getState().pendingCommand).toBe('start');

    await waitUntil(() => received.length === 4);
    expect(received.map((message) => message.type)).toEqual(['lobby.settings', 'lobby.lock', 'lobby.ready', 'lobby.start']);
    expect(received[0]).toMatchObject({ roomId: 'room-1', payload: { sidePreference: 'host-red', timeControlId: 'standard' } });
    expect(received[1]).toMatchObject({ roomId: 'room-1', payload: { locked: true } });
    expect(received[2]).toMatchObject({ roomId: 'room-1', payload: { ready: true, settingsVersion: 1 } });

    sockets[0]?.send(
      buildServerMessage({ type: 'lobby.state', roomId: 'room-1', payload: { lobby: createLobbyState() } }),
    );
    await waitUntil(() => client.getState().pendingCommand === null);
  });

  it('keeps the connection alive on a non-fatal lobby rejection and surfaces actionable copy', async () => {
    const sockets: NodeWebSocket[] = [];
    const server = await startServer((socket) => {
      sockets.push(socket);
      socket.on('message', () => {
        socket.send(
          buildServerMessage({
            type: 'welcome',
            roomId: 'room-1',
            payload: { roomId: 'room-1', memberId: 'host-1', role: 'host', name: '房主', members, lobby: createLobbyState() },
          }),
        );
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'host', name: '房主', token: 't' });
    await waitUntil(() => client.getState().status === 'connected');

    sockets[0]?.send(
      buildServerMessage({ type: 'lobby.rejected', roomId: 'room-1', payload: { code: 'NOT_READY', message: 'not-ready' } }),
    );
    await waitUntil(() => client.getState().lastRejection !== null);
    expect(client.getState().status).toBe('connected');
    expect(client.getState().lastRejection?.code).toBe('NOT_READY');
    expect(client.getState().lastRejection?.message).toContain('等待双方准备');
    expect(client.getState().pendingCommand).toBeNull();

    // 拒绝后仍可继续操作：新请求正常发出，权威状态到达时提示被清除。
    client.sendLobbyStart();
    expect(client.getState().pendingCommand).toBe('start');
    sockets[0]?.send(
      buildServerMessage({ type: 'lobby.state', roomId: 'room-1', payload: { lobby: createLobbyState() } }),
    );
    await waitUntil(() => client.getState().lastRejection === null);
    expect(client.getState().status).toBe('connected');
  });

  it('measures round-trip latency upon receiving pong from server', async () => {
    const server = await startServer((socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          socket.send(
            buildServerMessage({
              type: 'welcome',
              roomId: 'room-1',
              payload: {
                roomId: 'room-1',
                memberId: 'guest-1',
                role: 'guest',
                name: '客人',
                members,
                lobby: createLobbyState(),
                resumeToken: 'res-token-1',
              },
            }),
          );
        } else if (msg.type === 'ping') {
          socket.send(
            buildServerMessage({
              type: 'pong',
              roomId: 'room-1',
              payload: { seq: msg.payload.seq },
            }),
          );
        }
      });
    });

    const client = new RoomClient({
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
      connectTimeoutMs: 2000,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 200,
    });
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'connected');
    await waitUntil(() => typeof client.getState().rtt === 'number');
    expect(client.getState().rtt).toBeGreaterThanOrEqual(0);
    client.disconnect();
  });

  it('detects silent disconnection via heartbeat timeout and enters reconnecting state', async () => {
    let dropPings = false;
    const server = await startServer((socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          socket.send(
            buildServerMessage({
              type: 'welcome',
              roomId: 'room-1',
              payload: {
                roomId: 'room-1',
                memberId: 'guest-1',
                role: 'guest',
                name: '客人',
                members,
                lobby: createLobbyState(),
                resumeToken: 'res-token-2',
              },
            }),
          );
        } else if (msg.type === 'ping' && !dropPings) {
          socket.send(
            buildServerMessage({
              type: 'pong',
              roomId: 'room-1',
              payload: { seq: msg.payload.seq },
            }),
          );
        }
      });
    });

    const client = new RoomClient({
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
      connectTimeoutMs: 2000,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 100,
      reconnectDelays: [50, 100],
    });
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'connected');
    dropPings = true;

    await waitUntil(() => client.getState().status === 'reconnecting', 2000);
    expect(client.getState().reconnecting).toBe(true);
    expect(client.getState().rtt).toBeNull();
    client.disconnect();
  });

  it('reconnects successfully and restores connected state with session resume credentials', async () => {
    let reconnectAttempts = 0;
    const server = await startServer((socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          if (msg.payload.resumeToken === 'token-res-3') {
            reconnectAttempts += 1;
            socket.send(
              buildServerMessage({
                type: 'welcome',
                roomId: 'room-1',
                payload: {
                  roomId: 'room-1',
                  memberId: 'guest-1',
                  role: 'guest',
                  name: '客人',
                  members,
                  lobby: createLobbyState(),
                  resumeToken: 'token-res-3',
                },
              }),
            );
          } else {
            socket.send(
              buildServerMessage({
                type: 'welcome',
                roomId: 'room-1',
                payload: {
                  roomId: 'room-1',
                  memberId: 'guest-1',
                  role: 'guest',
                  name: '客人',
                  members,
                  lobby: createLobbyState(),
                  resumeToken: 'token-res-3',
                },
              }),
            );
          }
        }
      });
    });

    const client = new RoomClient({
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
      connectTimeoutMs: 2000,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 80,
      reconnectDelays: [30, 60],
    });
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'connected');

    // 终止当前服务器连接（模拟连接突发中断）
    for (const ws of server.wss.clients) {
      ws.terminate();
    }

    // 客户端应自动重连并成功
    await waitUntil(() => reconnectAttempts >= 1 && client.getState().status === 'connected', 3000);
    expect(client.getState().status).toBe('connected');
    expect(client.getState().reconnecting).toBe(false);
    expect(client.getState().justReconnected).toBe(true);
    client.disconnect();
  });

  it('exhausts reconnect budget and transitions to disconnected with actionable copy', async () => {
    let allowJoin = true;
    const server = await startServer((socket) => {
      if (!allowJoin) {
        socket.terminate();
        return;
      }
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          socket.send(
            buildServerMessage({
              type: 'welcome',
              roomId: 'room-1',
              payload: {
                roomId: 'room-1',
                memberId: 'guest-1',
                role: 'guest',
                name: '客人',
                members,
                lobby: createLobbyState(),
                resumeToken: 'token-res-budget',
              },
            }),
          );
        }
      });
    });

    const client = new RoomClient({
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
      connectTimeoutMs: 50,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 50,
      reconnectDelays: [30, 30],
      reconnectBudgetMs: 100, // 短预算
    });
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'connected');
    allowJoin = false;
    for (const ws of server.wss.clients) {
      ws.terminate();
    }

    await waitUntil(() => client.getState().status === 'disconnected', 3000);
    expect(client.getState().reconnecting).toBe(false);
    expect(client.getState().message).toContain('房间不可达，可能网络断开或房主退出');
    client.disconnect();
  });

  it('stops reconnecting on room.closed or fatal UNAUTHORIZED rejection', async () => {
    let reconnectTries = 0;
    const server = await startServer((socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          if (reconnectTries === 0) {
            socket.send(
              buildServerMessage({
                type: 'welcome',
                roomId: 'room-1',
                payload: {
                  roomId: 'room-1',
                  memberId: 'guest-1',
                  role: 'guest',
                  name: '客人',
                  members,
                  lobby: createLobbyState(),
                  resumeToken: 'token-fatal',
                },
              }),
            );
          } else {
            // 重连时拒绝（例如凭据失效）
            socket.send(
              buildServerMessage({
                type: 'error',
                roomId: 'room-1',
                payload: { code: 'UNAUTHORIZED', message: 'bad-resume-token' },
              }),
            );
            socket.close(closeCodeForError('UNAUTHORIZED'), 'UNAUTHORIZED');
          }
        }
      });
    });

    const client = new RoomClient({
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
      connectTimeoutMs: 2000,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 50,
      reconnectDelays: [30, 50],
    });
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });

    await waitUntil(() => client.getState().status === 'connected');
    reconnectTries = 1;
    for (const ws of server.wss.clients) {
      ws.terminate();
    }

    await waitUntil(() => client.getState().status === 'error', 3000);
    expect(client.getState().errorCode).toBe('UNAUTHORIZED');
    expect(client.getState().reconnecting).toBe(false);
    client.disconnect();
  });

  describe('online match action coordination', () => {
    it('handles optimistic action, duplicate step preservation, rejection requestId matching, and hydration', async () => {
      let serverSocket: NodeWebSocket | null = null;
      const startParameters = buildStartParameters({
        roomId: 'room-1',
        host: { memberId: 'host-1', name: '房主' },
        guest: { memberId: 'guest-1', name: '客人' },
        settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
        hostSide: 'red',
      });
      const match = createMatch({ matchId: 'm1', seed: 42, startParameters });
      const snap0 = snapshotMatch(match);

      const server = await startServer((socket) => {
        serverSocket = socket;
        socket.on('message', (raw) => {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type === 'hello') {
            socket.send(
              buildServerMessage({
                type: 'welcome',
                roomId: 'room-1',
                payload: {
                  roomId: 'room-1',
                  memberId: 'host-1',
                  role: 'host',
                  name: '房主',
                  members: [
                    { id: 'host-1', role: 'host', name: '房主', connected: true },
                    { id: 'guest-1', role: 'guest', name: '客人', connected: true },
                  ],
                  lobby: {
                    phase: 'started',
                    settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
                    ready: { host: true, guest: true },
                    presence: { host: true, guest: true },
                    startParameters,
                  },
                  game: snap0,
                },
              }),
            );
          }
        });
      });

      const client = makeClient();
      client.connect({ host: '127.0.0.1', port: server.port }, { role: 'host', name: '房主', token: 'token' });
      await waitUntil(() => client.getState().game !== null);

      const initialGame = client.getState().game!;
      expect(initialGame.stepNumber).toBe(0);
      expect(initialGame.pendingAction).toBeNull();
      expect(initialGame.lastAcceptedAction).toBeNull();

      // 1. 本地执行乐观翻牌 (0, 6)
      const res = client.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
      expect(res.ok).toBe(true);

      const afterAction = client.getState().game!;
      expect(afterAction.pendingAction).not.toBeNull();
      expect(afterAction.pendingAction?.stepNumber).toBe(0);
      expect(afterAction.lastAcceptedAction?.source).toBe('local');
      const pendingReqId = afterAction.pendingAction!.requestId;

      // 2. 服务端重发第 0 步快照（重复广播）-> 不得撤销在途 pendingAction，不得覆盖 displayState
      serverSocket!.send(
        buildServerMessage({
          type: 'game.state',
          roomId: 'room-1',
          payload: {
            matchId: snap0.matchId,
            seed: snap0.seed,
            stepNumber: 0,
            state: snap0.gameState,
            startParameters: snap0.startParameters,
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(client.getState().game?.pendingAction?.requestId).toBe(pendingReqId);

      // 3. 服务端发送旧 requestId 的延迟拒绝 -> 不得撤销当前 pendingAction
      serverSocket!.send(
        buildServerMessage({
          type: 'game.rejected',
          roomId: 'room-1',
          requestId: 'old-stale-req-id',
          payload: {
            matchId: snap0.matchId,
            stepNumber: 0,
            reason: '过期的旧请求拒绝',
            state: snap0.gameState,
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(client.getState().game?.pendingAction?.requestId).toBe(pendingReqId);

      // 4. 服务端发送匹配 pendingReqId 的真实拒绝 -> 回滚 displayState 至 confirmedState，设置 notice
      serverSocket!.send(
        buildServerMessage({
          type: 'game.rejected',
          roomId: 'room-1',
          requestId: pendingReqId,
          payload: {
            matchId: snap0.matchId,
            stepNumber: 0,
            reason: '你的操作未被采纳，请重新操作',
            state: snap0.gameState,
          },
        }),
      );
      await waitUntil(() => client.getState().game?.pendingAction === null);
      const rejectedGame = client.getState().game!;
      expect(rejectedGame.statusNotice).toBe('你的操作未被采纳，请重新操作');
      expect(rejectedGame.displayState.pieces).toEqual(snap0.gameState.pieces);
      expect(rejectedGame.displayState.currentTurn).toBe(snap0.gameState.currentTurn);
      expect(rejectedGame.lastAcceptedAction).toBeNull();

      // 5. 同一步重试翻牌 (0, 6) -> 再次产生新 pendingAction 并可正常发送
      const retryRes = client.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
      expect(retryRes.ok).toBe(true);
      expect(client.getState().game?.pendingAction).not.toBeNull();
      expect(client.getState().game?.pendingAction?.requestId).not.toBe(pendingReqId);

      // 6. 服务端跳步快照（步数跳到 3）以 hydration 处理 -> 清理 pendingAction 且不补播动画
      serverSocket!.send(
        buildServerMessage({
          type: 'game.state',
          roomId: 'room-1',
          payload: {
            matchId: snap0.matchId,
            seed: snap0.seed,
            stepNumber: 3,
            state: snap0.gameState,
            startParameters: snap0.startParameters,
            actorMemberId: 'guest-1',
            action: { type: 'flip', position: { x: 0, y: 3 } },
          },
        }),
      );
      await waitUntil(() => client.getState().game?.stepNumber === 3);
      expect(client.getState().game?.pendingAction).toBeNull();
      expect(client.getState().game?.lastAcceptedAction).toBeNull();

      client.disconnect();
    });

    it('handles game.clock updates, calculates NTP clock offset, and supports sendLobbyReturn', async () => {
      let serverSocket: NodeWebSocket | null = null;
      const startParameters = buildStartParameters({
        roomId: 'room-1',
        host: { memberId: 'host-1', name: '房主' },
        guest: { memberId: 'guest-1', name: '客人' },
        settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
        hostSide: 'red',
      });
      const match = createMatch({ matchId: 'm-1', seed: 42, startParameters });
      const snap0 = snapshotMatch(match, 1000);

      const server = await startServer((socket) => {
        serverSocket = socket;
        socket.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'hello') {
            socket.send(
              buildServerMessage({
                type: 'welcome',
                roomId: 'room-1',
                payload: {
                  roomId: 'room-1',
                  memberId: 'host-1',
                  role: 'host',
                  name: '房主',
                  members,
                  lobby: createLobbyState(),
                  game: snap0,
                },
              }),
            );
          }
          if (msg.type === 'ping') {
            socket.send(
              buildServerMessage({
                type: 'pong',
                roomId: 'room-1',
                payload: {
                  seq: msg.payload.seq,
                  clientSendTime: msg.payload.clientTime,
                  serverReceiveTime: 1050,
                  serverSendTime: 1052,
                },
              }),
            );
          }
        });
      });

      let simulatedTime = 1000;
      const client = new RoomClient({
        webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
        clock: { now: () => simulatedTime },
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 100,
      });

      client.connect({ host: '127.0.0.1', port: server.port }, { role: 'host', name: '房主', token: 'token-1' });
      await waitUntil(() => client.getState().game !== null);

      // 验证 welcome 中携带的 clock
      expect(client.getState().game?.clock?.turn).toBe('red');

      // 推进模拟时间并等待 pong 计算 NTP offset
      simulatedTime = 1010;
      await waitUntil(() => client.getState().game?.clockOffsetMs !== 0);
      expect(typeof client.getState().game?.clockOffsetMs).toBe('number');

      // 收到 game.clock 广播
      serverSocket!.send(
        buildServerMessage({
          type: 'game.clock',
          roomId: 'room-1',
          payload: {
            matchId: 'm-1',
            sampleSeq: 1,
            revision: snap0.revision,
            clock: {
              ...snap0.clock!,
              sampleSeq: 1,
              red: { ...snap0.clock!.red, baseTimeRemainingMs: 1195_000 },
            },
          },
        }),
      );
      await waitUntil(() => client.getState().game?.clock?.red.baseTimeRemainingMs === 1195_000);
      expect(client.getState().game?.revision).toBe(snap0.revision);

      // 发送 lobby.return (rematch)
      const receivedMessages: any[] = [];
      serverSocket!.on('message', (d) => receivedMessages.push(JSON.parse(d.toString())));
      client.sendLobbyReturn('rematch');
      await waitUntil(() => receivedMessages.some((m) => m.type === 'lobby.return'));
      const returnMsg = receivedMessages.find((m) => m.type === 'lobby.return');
      expect(returnMsg.payload.intent).toBe('rematch');
      expect(returnMsg.payload.matchId).toBe('m-1');

      client.disconnect();
    });
  });
});


describe('RoomClient spectator mode', () => {
  const spectatorMembers = [
    { id: 'host-1', role: 'host' as const, name: '房主', connected: true },
    { id: 'guest-1', role: 'guest' as const, name: '客人', connected: true },
    { id: 'spec-1', role: 'spectator' as const, name: '旁观1', connected: true },
  ];

  it('adopts the authoritative identity from welcome and reconnects as spectator', async () => {
    const hellos: Array<Record<string, any>> = [];
    const server = await startServer((socket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          hellos.push(msg);
          socket.send(
            buildServerMessage({
              type: 'welcome',
              roomId: 'room-1',
              payload: {
                roomId: 'room-1',
                memberId: 'spec-1',
                // 普通加入被服务端分流为旁观：以 welcome 实际身份为准。
                role: 'spectator',
                name: '旁观1',
                members: spectatorMembers,
                lobby: createLobbyState(),
                resumeToken: 'spec-token-1',
              },
            }),
          );
        }
      });
    });

    const client = new RoomClient({
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocketLike,
      connectTimeoutMs: 2000,
      reconnectDelays: [30, 60],
    });
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'guest', name: '客人' });
    await waitUntil(() => client.getState().status === 'connected');
    expect(client.getState().role).toBe('spectator');
    expect(hellos[0].payload.role).toBe('guest');

    for (const ws of server.wss.clients) {
      ws.terminate();
    }

    await waitUntil(() => hellos.length >= 2 && client.getState().status === 'connected', 3000);
    // 重连握手必须携带实际旁观身份与本人恢复凭据。
    expect(hellos[1].payload.role).toBe('spectator');
    expect(hellos[1].payload.resumeToken).toBe('spec-token-1');
    client.disconnect();
  });

  it('blocks every game and lobby send with no network traffic and no optimistic state', async () => {
    const startParameters = buildStartParameters({
      roomId: 'room-1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });
    const match = createMatch({ matchId: 'm-1', seed: 42, startParameters });
    const snap0 = snapshotMatch(match, 1000);

    let serverSocket: NodeWebSocket | null = null;
    const received: Array<Record<string, any>> = [];
    const server = await startServer((socket) => {
      serverSocket = socket;
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        if (msg.type === 'hello') {
          socket.send(
            buildServerMessage({
              type: 'welcome',
              roomId: 'room-1',
              payload: {
                roomId: 'room-1',
                memberId: 'spec-1',
                role: 'spectator',
                name: '旁观1',
                members: spectatorMembers,
                lobby: createLobbyState(),
                game: snap0,
              },
            }),
          );
        }
      });
    });

    const client = makeClient();
    client.connect({ host: '127.0.0.1', port: server.port }, { role: 'spectator', name: '旁观' });
    await waitUntil(() => client.getState().game !== null);
    expect(serverSocket).not.toBeNull();

    const displayBefore = client.getState().game!.displayState;
    const actionResult = client.sendGameAction({ type: 'flip', position: { x: 0, y: 3 } });
    expect(actionResult.ok).toBe(false);
    expect(actionResult.reason).toContain('旁观');

    expect(client.sendGameNegotiate('undo').ok).toBe(false);
    expect(client.sendGameNegotiateReply(true).ok).toBe(false);
    expect(client.sendGameResign().ok).toBe(false);
    expect(client.sendChatPhrase('phrase-greeting-1').ok).toBe(false);

    client.sendLobbySettings('random', 'none');
    client.sendLobbyLock(true);
    client.sendLobbyReady(true);
    client.sendLobbyStart();
    client.sendLobbyReturn('rematch');

    // 无任何消息发出（只有 hello），也无乐观局面。
    expect(received.map((m) => m.type)).toEqual(['hello']);
    expect(client.getState().game!.displayState).toBe(displayBefore);
    expect(client.getState().game!.pendingAction).toBeNull();
    expect(client.getState().pendingCommand).toBeNull();

    // game.sync 是旁观者唯一可用的对局请求通道。
    client.requestGameSync();
    await waitUntil(() => received.some((m) => m.type === 'game.sync'));
    client.disconnect();
  });
});
