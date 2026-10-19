// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { startRoomServer, type RoomServer } from '../room-server';
import {
  buildClientChatPhrase,
  buildClientHello,
  buildClientLobbyReady,
  buildClientLobbySettings,
  buildClientLobbyStart,
  buildPong,
  encodeMessage,
  type HelloPayload,
} from '../../src/network/protocol';

interface TestClient {
  socket: WebSocket;
  messages: Array<Record<string, any>>;
  closeCode: () => number | null;
  waitForType: (type: string, predicate?: (message: Record<string, any>) => boolean) => Promise<Record<string, any>>;
  send: (raw: string) => void;
  closed: Promise<number>;
}

const openClients: TestClient[] = [];
const serversToStop: Array<() => Promise<void>> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function openClient(port: number): Promise<TestClient> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, any>> = [];
    const waiters: Array<{ type: string; predicate?: (message: Record<string, any>) => boolean; resolve: (message: Record<string, any>) => void }> = [];
    let closeCode: number | null = null;
    let resolveClosed: (code: number) => void = () => undefined;
    const closed = new Promise<number>((res) => {
      resolveClosed = res;
    });

    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, any>;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.type === message.type && (!waiter.predicate || waiter.predicate(message))) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    socket.on('close', (code) => {
      closeCode = code;
      resolveClosed(code);
    });
    socket.on('error', () => undefined);
    socket.on('open', () => {
      const client: TestClient = {
        socket,
        messages,
        closeCode: () => closeCode,
        waitForType: (type, predicate) => {
          const existing = messages.find((m) => m.type === type && (!predicate || predicate(m)));
          if (existing) {
            return Promise.resolve(existing);
          }
          return new Promise((res) => {
            waiters.push({ type, predicate, resolve: res });
          });
        },
        send: (raw) => socket.send(raw),
        closed,
      };
      openClients.push(client);
      resolve(client);
    });
  });
}

function hello(client: TestClient, payload: HelloPayload, roomId: string | null = null): Promise<Record<string, any>> {
  client.send(encodeMessage(buildClientHello({ ...payload, roomId })));
  return client.waitForType('welcome');
}

function enableAutoPong(client: TestClient, roomId: string): void {
  client.socket.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as { type?: string; payload?: { seq?: number } };
      if (parsed.type === 'ping' && typeof parsed.payload?.seq === 'number') {
        client.socket.send(encodeMessage(buildPong(roomId, parsed.payload.seq)));
      }
    } catch {
      // 忽略
    }
  });
}

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    try {
      client.socket.close();
    } catch {
      // 忽略
    }
  }
  for (const stop of serversToStop.splice(0)) {
    await stop();
  }
});

async function startTestMatch(): Promise<{
  server: RoomServer;
  roomId: string;
  host: TestClient;
  guest: TestClient;
  matchId: string;
  hostId: string;
  guestId: string;
}> {
  const port = await freePort();
  const started = await startRoomServer({ preferredPort: port, logger: () => undefined });
  const server = started.server;
  serversToStop.push(async () => {
    if (!server.isClosed) {
      await server.closeRoom('server-stopped');
    }
  });
  const roomId = started.roomId;

  const host = await openClient(port);
  const hostWelcome = await hello(host, { role: 'host', name: '房主', token: started.hostToken });
  enableAutoPong(host, roomId);

  const guest = await openClient(port);
  const guestWelcome = await hello(guest, { role: 'guest', name: '客人' }, roomId);
  enableAutoPong(guest, roomId);

  host.send(encodeMessage(buildClientLobbySettings(roomId, { sidePreference: 'host-red', timeControlId: 'none' })));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.settings.sidePreference === 'host-red');

  host.send(encodeMessage(buildClientLobbyReady(roomId, true, 2)));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.ready.host === true);
  guest.send(encodeMessage(buildClientLobbyReady(roomId, true, 2)));
  await host.waitForType(
    'lobby.state',
    (m) => m.payload.lobby.ready.host === true && m.payload.lobby.ready.guest === true,
  );

  host.send(encodeMessage(buildClientLobbyStart(roomId)));
  const gameState = await host.waitForType('game.state');

  return {
    server,
    roomId,
    host,
    guest,
    matchId: gameState.payload.matchId,
    hostId: hostWelcome.payload.memberId,
    guestId: guestWelcome.payload.memberId,
  };
}

describe('RoomServer quick phrase interactions', () => {
  it('broadcasts valid chat phrase to all participants', async () => {
    const { roomId, host, guest, matchId, hostId } = await startTestMatch();

    host.send(
      encodeMessage(
        buildClientChatPhrase(roomId, {
          matchId,
          phraseId: 'phrase-greeting-1',
          requestId: 'chat-req-1',
        }),
      ),
    );

    const hostChat = await host.waitForType('chat.phrase');
    const guestChat = await guest.waitForType('chat.phrase');

    expect(hostChat.payload).toMatchObject({
      matchId,
      senderMemberId: hostId,
      phraseId: 'phrase-greeting-1',
      text: '你好，很高兴和你对弈！',
    });
    expect(guestChat.payload).toEqual(hostChat.payload);
    expect(hostChat.payload.nextAllowedAt).toBeGreaterThan(hostChat.payload.sentAt);
  });

  it('enforces 5s cooldown per player and returns COOLDOWN rejection', async () => {
    const { roomId, host, matchId } = await startTestMatch();

    host.send(
      encodeMessage(
        buildClientChatPhrase(roomId, {
          matchId,
          phraseId: 'phrase-greeting-1',
          requestId: 'chat-req-1',
        }),
      ),
    );
    await host.waitForType('chat.phrase');

    // 立即发送第二条短语
    host.send(
      encodeMessage(
        buildClientChatPhrase(roomId, {
          matchId,
          phraseId: 'phrase-praise-1',
          requestId: 'chat-req-2',
        }),
      ),
    );

    const rejection = await host.waitForType('chat.phrase.rejected', (m) => m.requestId === 'chat-req-2');
    expect(rejection.payload.code).toBe('COOLDOWN');
    expect(rejection.payload.message).toContain('冷却中');
    expect(rejection.payload.retryAt).toBeDefined();
  });

  it('rejects invalid/non-whitelisted phrase IDs with INVALID_PHRASE', async () => {
    const { roomId, guest, matchId } = await startTestMatch();

    guest.send(
      encodeMessage(
        buildClientChatPhrase(roomId, {
          matchId,
          phraseId: 'custom-illegal-phrase',
          requestId: 'chat-req-bad',
        }),
      ),
    );

    const rejection = await guest.waitForType('chat.phrase.rejected', (m) => m.requestId === 'chat-req-bad');
    expect(rejection.payload.code).toBe('INVALID_PHRASE');
  });

  it('rejects chat phrases when match is not active', async () => {
    const port = await freePort();
    const started = await startRoomServer({ preferredPort: port, logger: () => undefined });
    serversToStop.push(async () => {
      if (!started.server.isClosed) {
        await started.server.closeRoom('server-stopped');
      }
    });
    const client = await openClient(port);
    await hello(client, { role: 'host', name: '房主', token: started.hostToken });

    client.send(
      encodeMessage(
        buildClientChatPhrase(started.roomId, {
          matchId: 'inactive-match',
          phraseId: 'phrase-greeting-1',
          requestId: 'req-inactive',
        }),
      ),
    );

    const rejection = await client.waitForType('chat.phrase.rejected');
    expect(rejection.payload.code).toBe('MATCH_NOT_ACTIVE');
  });
});
