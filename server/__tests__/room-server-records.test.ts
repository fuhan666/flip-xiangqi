// @vitest-environment node
/**
 * 真实 loopback WebSocket：终局棋谱的出站形状与授权拒绝。
 *
 * 断言的是实际收到的消息，而非内部 helper：
 * - 进行中请求只得到 NOT_FINISHED，且整个会话出站不含完整初始布局；
 * - 终局后双方玩家与本房获准旁观者各收到同一份服务器棋谱；
 * - 另一房间按自己的会话查同名 matchId 只得到 UNAVAILABLE，无记录正文。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RoomServer, type RoomServerOptions } from '../room-server';
import {
  buildClientGameRecordRequest,
  buildClientGameResign,
  buildClientHello,
  buildClientLobbyReady,
  buildClientLobbySettings,
  buildClientLobbyStart,
  encodeMessage,
  type HelloPayload,
} from '../../src/network/protocol';
import { parseRecord } from '../../src/records/record';

interface TestClient {
  socket: WebSocket;
  messages: Array<Record<string, any>>;
  waitForType: (type: string, predicate?: (message: Record<string, any>) => boolean) => Promise<Record<string, any>>;
  send: (raw: string) => void;
}

const openClients: TestClient[] = [];
const serversToStop: Array<() => Promise<void>> = [];

function openClient(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, any>> = [];
    const waiters: Array<{ type: string; predicate?: (message: Record<string, any>) => boolean; resolve: (message: Record<string, any>) => void }> = [];
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
    socket.on('error', () => undefined);
    socket.on('open', () => {
      const client: TestClient = {
        socket,
        messages,
        waitForType: (type, predicate) =>
          new Promise((resolveWait, rejectWait) => {
            const matches = messages.filter((message) => message.type === type && (!predicate || predicate(message)));
            if (matches.length > 0) {
              resolveWait(matches[matches.length - 1]);
              return;
            }
            waiters.push({ type, predicate, resolve: resolveWait });
            setTimeout(() => rejectWait(new Error(`timed out waiting for ${type}`)), 3000);
          }),
        send: (raw) => socket.send(raw),
      };
      openClients.push(client);
      resolve(client);
    });
    socket.on('error', reject);
  });
}

async function hello(client: TestClient, payload: HelloPayload, roomId: string | null = null): Promise<Record<string, any>> {
  client.send(encodeMessage(buildClientHello({ ...payload, roomId })));
  return client.waitForType('welcome');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startRoom(overrides: Partial<RoomServerOptions> = {}): Promise<RoomServer> {
  const server = new RoomServer({
    preferredPort: await freePort(),
    handshakeTimeoutMs: 300,
    logger: () => undefined,
    ...overrides,
  });
  await server.start();
  serversToStop.push(async () => {
    if (!server.isClosed) {
      await server.closeRoom('server-stopped');
    }
  });
  return server;
}

async function startedRoom(): Promise<{ room: RoomServer; host: TestClient; guest: TestClient; matchId: string }> {
  const room = await startRoom();
  const host = await openClient(room.actualPort);
  await hello(host, { role: 'host', name: '房主', token: room.hostToken });
  const guest = await openClient(room.actualPort);
  await hello(guest, { role: 'guest', name: '客人' });
  host.send(encodeMessage(buildClientLobbySettings(room.roomId, { sidePreference: 'host-red', timeControlId: 'standard' })));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.settings.sidePreference === 'host-red');
  host.send(encodeMessage(buildClientLobbyReady(room.roomId, true, 2)));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.ready.host === true);
  guest.send(encodeMessage(buildClientLobbyReady(room.roomId, true, 2)));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.ready.host === true && m.payload.lobby.ready.guest === true);
  host.send(encodeMessage(buildClientLobbyStart(room.roomId)));
  const started = await host.waitForType('game.state');
  return { room, host, guest, matchId: started.payload.matchId };
}

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop();
    try {
      client?.socket.terminate();
    } catch {
      // 已关闭。
    }
  }
  while (serversToStop.length > 0) {
    await serversToStop.pop()?.();
  }
});

describe('真实 WebSocket 的终局棋谱交付', () => {
  it('进行中拒绝，终局后双方与获准观众取回同一份服务器棋谱', async () => {
    const { room, host, guest, matchId } = await startedRoom();
    const spectator = await openClient(room.actualPort);
    await hello(spectator, { role: 'spectator', name: '观众' });

    for (const [client, id] of [[host, 'h-early'], [spectator, 's-early']] as const) {
      client.send(encodeMessage(buildClientGameRecordRequest(room.roomId, { requestId: id, matchId })));
      const denied = await client.waitForType('game.record.unavailable', (m) => m.requestId === id);
      expect(denied.payload.code).toBe('NOT_FINISHED');
      expect(denied.payload).not.toHaveProperty('json');
      expect(denied.payload).not.toHaveProperty('text');
    }

    host.send(encodeMessage(buildClientGameResign(room.roomId, { requestId: 'resign', matchId, revision: 0 })));
    const summary = await spectator.waitForType('game.records', (m) => m.payload.records.some((r: any) => r.matchId === matchId));
    expect(summary.payload.records[0]).toEqual({ matchId, endedAt: expect.any(Number), expiresAt: expect.any(Number) });
    expect(Object.keys(summary.payload.records[0])).toEqual(['matchId', 'endedAt', 'expiresAt']);

    const outputs: Array<Record<string, any>> = [];
    for (const [client, id] of [[host, 'h-rec'], [guest, 'g-rec'], [spectator, 's-rec']] as const) {
      client.send(encodeMessage(buildClientGameRecordRequest(room.roomId, { requestId: id, matchId })));
      const record = await client.waitForType('game.record', (m) => m.requestId === id);
      outputs.push(record);
      expect(parseRecord(record.payload.json).result.reason).toBe('resignation');
    }
    expect(new Set(outputs.map((message) => message.payload.json)).size).toBe(1);
    expect(new Set(outputs.map((message) => message.payload.text)).size).toBe(1);
  });

  it('另一房间与伪造 matchId 只得到安全拒绝，不含任何记录正文', async () => {
    const first = await startedRoom();
    first.host.send(encodeMessage(buildClientGameResign(first.room.roomId, { requestId: 'resign', matchId: first.matchId, revision: 0 })));
    await first.host.waitForType('game.records', (m) => m.payload.records.some((r: any) => r.matchId === first.matchId));

    const second = await startedRoom();
    second.host.send(encodeMessage(buildClientGameRecordRequest(second.room.roomId, { requestId: 'cross', matchId: first.matchId })));
    const denied = await second.host.waitForType('game.record.unavailable', (m) => m.requestId === 'cross');
    expect(denied.payload).toMatchObject({ matchId: first.matchId, code: 'UNAVAILABLE' });
    expect(second.host.messages.filter((m) => m.type === 'game.record')).toHaveLength(0);

    second.host.send(encodeMessage(buildClientGameRecordRequest(second.room.roomId, { requestId: 'fake', matchId: 'not-a-match' })));
    const fake = await second.host.waitForType('game.record.unavailable', (m) => m.requestId === 'fake');
    expect(fake.payload.code).toBe('UNAVAILABLE');

    const outbound = JSON.stringify(second.host.messages);
    expect(outbound).not.toContain('"initial"');
    expect(outbound).not.toContain('"seed"');
  });
});
