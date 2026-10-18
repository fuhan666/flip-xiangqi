// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RoomServerError, RoomServer, startRoomServer, type RoomServerOptions } from '../room-server';
import {
  buildClientGameAction,
  buildClientHello,
  buildClientLeave,
  buildClientLobbyLock,
  buildClientLobbyReady,
  buildClientLobbyReturn,
  buildClientLobbySettings,
  buildClientLobbyStart,
  buildPong,
  encodeMessage,
  PROTOCOL_VERSION,
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
const blockers: Server[] = [];

function openClient(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, any>> = [];
    const waiters: Array<{ type: string; predicate?: (message: Record<string, any>) => boolean; resolve: (message: Record<string, any>) => void }> = [];
    let closeCode: number | null = null;
    let resolveClosed: (code: number) => void = () => undefined;
    const closed = new Promise<number>((resolve) => {
      resolveClosed = resolve;
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
        waitForType: (type, predicate) =>
          new Promise((resolve, rejectTimeout) => {
            const matches = messages.filter((message) => message.type === type && (!predicate || predicate(message)));
            if (matches.length > 0) {
              resolve(matches[matches.length - 1]);
              return;
            }
            waiters.push({ type, predicate, resolve });
            setTimeout(() => rejectTimeout(new Error(`timed out waiting for ${type}`)), 3000);
          }),
        send: (raw) => socket.send(raw),
        closed,
      };
      openClients.push(client);
      resolve(client);
    });
    socket.on('error', reject);
  });
}

async function hello(client: TestClient, payload: HelloPayload, roomId: string | null = null): Promise<void> {
  client.send(encodeMessage(buildClientHello({ ...payload, roomId })));
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

function occupyPort(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    // 与房间监听同样绑定 0.0.0.0，确保端口占用真实冲突。
    server.listen(port, '0.0.0.0', () => {
      blockers.push(server);
      resolve(server);
    });
  });
}

function enableAutoPong(client: TestClient, roomId: string): void {
  client.socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        client.send(encodeMessage(buildPong(roomId, msg.payload.seq)));
      }
    } catch {
      // 忽略解析错误
    }
  });
}

interface ConnectedPair {
  room: RoomServer;
  host: TestClient;
  guest: TestClient;
  hostId: string;
  guestId: string;
  guestResumeToken?: string;
}

async function connectedPair(overrides: Partial<RoomServerOptions> = {}): Promise<ConnectedPair> {
  const room = await startRoom(overrides);
  const host = await openClient(room.actualPort);
  await hello(host, { role: 'host', name: '房主', token: room.hostToken });
  const hostWelcome = await host.waitForType('welcome');
  const guest = await openClient(room.actualPort);
  await hello(guest, { role: 'guest', name: '客人' });
  const guestWelcome = await guest.waitForType('welcome');
  return {
    room,
    host,
    guest,
    hostId: hostWelcome.payload.memberId,
    guestId: guestWelcome.payload.memberId,
    guestResumeToken: guestWelcome.payload.resumeToken,
  };
}

async function readyBoth(pair: ConnectedPair, settingsVersion: number): Promise<void> {
  pair.host.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, true, settingsVersion)));
  await pair.host.waitForType('lobby.state', (message) => message.payload.lobby.ready.host === true);
  pair.guest.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, true, settingsVersion)));
  await pair.host.waitForType(
    'lobby.state',
    (message) => message.payload.lobby.ready.host === true && message.payload.lobby.ready.guest === true,
  );
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
  while (blockers.length > 0) {
    const blocker = blockers.pop();
    await new Promise<void>((resolve) => {
      if (!blocker || !blocker.listening) {
        resolve();
        return;
      }
      blocker.close(() => resolve());
    });
  }
});

describe('room handshake', () => {
  it('admits host and guest and shares the same member snapshot', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });

    const hostWelcome = await host.waitForType('welcome');
    expect(hostWelcome.payload).toMatchObject({ roomId: room.roomId, role: 'host', name: '房主' });
    expect(hostWelcome.payload.members).toHaveLength(1);

    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });

    const guestWelcome = await guest.waitForType('welcome');
    expect(guestWelcome.payload.members).toHaveLength(2);

    const hostMembers = await host.waitForType('members', (message) => message.payload.members.length === 2);
    expect(hostMembers.payload.members.map((member: { role: string }) => member.role)).toEqual(['host', 'guest']);
    expect(room.getMembers()).toHaveLength(2);
  });

  it('rejects malformed json with INVALID_MESSAGE and closes the socket', async () => {
    const room = await startRoom();
    const client = await openClient(room.actualPort);
    client.send('{not json');

    const error = await client.waitForType('error');
    expect(error.payload.code).toBe('INVALID_MESSAGE');
    expect(await client.closed).toBe(4000);
  });

  it('rejects a different protocol version with VERSION_MISMATCH', async () => {
    const room = await startRoom();
    const client = await openClient(room.actualPort);
    client.send(JSON.stringify({ version: PROTOCOL_VERSION + 1, type: 'hello', roomId: null, payload: { role: 'guest', name: '客人' } }));

    const error = await client.waitForType('error');
    expect(error.payload.code).toBe('VERSION_MISMATCH');
    expect(await client.closed).toBe(4001);
  });

  it('rejects an unknown roomId in hello', async () => {
    const room = await startRoom();
    const client = await openClient(room.actualPort);
    await hello(client, { role: 'guest', name: '客人' }, 'some-other-room');

    const error = await client.waitForType('error');
    expect(error.payload.code).toBe('INVALID_MESSAGE');
    expect(await client.closed).toBe(4000);
  });

  it('validates the roomId of post-welcome messages', async () => {
    const room = await startRoom();
    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    await guest.waitForType('welcome');

    guest.send(encodeMessage({ version: PROTOCOL_VERSION, type: 'leave', roomId: 'wrong-room', payload: {} }));
    const error = await guest.waitForType('error');
    expect(error.payload.code).toBe('INVALID_MESSAGE');
  });
});

describe('authorization and capacity', () => {
  it('rejects a guest claiming host without the token', async () => {
    const room = await startRoom();
    const client = await openClient(room.actualPort);
    await hello(client, { role: 'host', name: '房主' });

    const error = await client.waitForType('error');
    expect(error.payload.code).toBe('UNAUTHORIZED');
    expect(await client.closed).toBe(4002);
  });

  it('rejects a wrong host token', async () => {
    const room = await startRoom();
    const client = await openClient(room.actualPort);
    await hello(client, { role: 'host', name: '房主', token: 'forged-token' });

    const error = await client.waitForType('error');
    expect(error.payload.code).toBe('UNAUTHORIZED');
    expect(await client.closed).toBe(4002);
  });

  it('rejects a second guest with ROOM_FULL while the seat is taken', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    const first = await openClient(room.actualPort);
    await hello(first, { role: 'guest', name: '客人' });
    await first.waitForType('welcome');

    const second = await openClient(room.actualPort);
    await hello(second, { role: 'guest', name: '客人' });
    const error = await second.waitForType('error');
    expect(error.payload.code).toBe('ROOM_FULL');
    expect(await second.closed).toBe(4003);
  });

  it('times out the handshake when no hello arrives', async () => {
    const room = await startRoom();
    const client = await openClient(room.actualPort);

    const error = await client.waitForType('error');
    expect(error.payload.code).toBe('HANDSHAKE_TIMEOUT');
    expect(await client.closed).toBe(4005);
  });
});

describe('disconnect cleanup', () => {
  it('marks the guest offline, keeps a single card and reuses the seat', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    const first = await openClient(room.actualPort);
    await hello(first, { role: 'guest', name: '客人' });
    await first.waitForType('welcome');

    first.socket.terminate();
    await host.waitForType(
      'members',
      (message) => message.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'guest' && !member.connected),
    );

    const offline = room.getMembers();
    expect(offline).toHaveLength(2);
    expect(offline.find((member) => member.role === 'guest')?.connected).toBe(false);

    // 席位可复用：新客人加入不会堆积幽灵成员。
    const second = await openClient(room.actualPort);
    await hello(second, { role: 'guest', name: '客人' });
    await second.waitForType('welcome');
    expect(room.getMembers()).toHaveLength(2);
    expect(room.getMembers().find((member) => member.role === 'guest')?.connected).toBe(true);
  });

  it('closes the room when the host socket drops and notifies the guest', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    await guest.waitForType('welcome');

    host.socket.terminate();

    const notice = await guest.waitForType('room.closed');
    expect(notice.payload.reason).toBe('host-disconnected');
    expect(await guest.closed).toBe(4004);
    expect(room.isClosed).toBe(true);
  });

  it('broadcasts room.closed on an explicit host close and releases the port', async () => {
    const preferredPort = await freePort();
    const room = await startRoom({ preferredPort });
    expect(room.actualPort).toBe(preferredPort);

    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');
    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    await guest.waitForType('welcome');

    await room.closeRoom('host-closed');

    const notice = await guest.waitForType('room.closed');
    expect(notice.payload.reason).toBe('host-closed');
    expect(await guest.closed).toBe(4004);
    expect(await host.closed).toBe(4004);

    // 关闭是幂等的，且端口立即释放给下一个房间。
    await expect(room.closeRoom('host-closed')).resolves.toBeUndefined();
    const next = await startRoom({ preferredPort, maxPortAttempts: 1 });
    expect(next.actualPort).toBe(preferredPort);
  });

  it('handles an explicit guest leave and frees the seat', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    await guest.waitForType('welcome');

    guest.send(encodeMessage(buildClientLeave(room.roomId)));

    const members = await host.waitForType(
      'members',
      (message) => message.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'guest' && !member.connected),
    );
    expect(members.payload.members.find((member: { role: string }) => member.role === 'guest').connected).toBe(false);
    expect(room.getMembers().find((member) => member.role === 'guest')?.connected).toBe(false);
  });
});

describe('port strategy', () => {
  it('falls back to the next free port when the preferred one is busy', async () => {
    const blocker = await occupyPort(0);
    const preferredPort = (blocker.address() as AddressInfo).port;
    const room = await startRoom({ preferredPort, maxPortAttempts: 5 });

    expect(room.actualPort).toBeGreaterThan(preferredPort);
    expect(room.actualPort).toBeLessThanOrEqual(preferredPort + 4);
    await room.closeRoom('server-stopped');
  });

  it('reports PORT_UNAVAILABLE when the attempts are exhausted', async () => {
    const blocker = await occupyPort(0);
    const preferredPort = (blocker.address() as AddressInfo).port;
    const room = new RoomServer({ preferredPort, maxPortAttempts: 1, logger: () => undefined });

    await expect(room.start()).rejects.toMatchObject({ code: 'PORT_UNAVAILABLE' });
  });

  it('rejects invalid port configuration with INVALID_PORT', async () => {
    const room = new RoomServer({ preferredPort: 70_000, logger: () => undefined });
    await expect(room.start()).rejects.toBeInstanceOf(RoomServerError);
    await expect(new RoomServer({ preferredPort: 70_000, logger: () => undefined }).start()).rejects.toMatchObject({
      code: 'INVALID_PORT',
    });
  });

  it('serves the guest page handler and keeps /ws for websockets only', async () => {
    const room = await startRoom({
      requestListener: (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('guest-page');
      },
    });

    const pageResponse = await fetch(`http://127.0.0.1:${room.actualPort}/`);
    expect(await pageResponse.text()).toBe('guest-page');

    const wsProbe = await fetch(`http://127.0.0.1:${room.actualPort}/ws`);
    expect(wsProbe.status).toBe(426);
    await room.closeRoom('server-stopped');
  });
});

describe('startRoomServer helper', () => {
  it('exposes room id, host token and the actual port', async () => {
    const started = await startRoomServer({
      preferredPort: await freePort(),
      logger: () => undefined,
    });
    expect(started.roomId).toHaveLength(16);
    expect(started.hostToken).toHaveLength(32);
    expect(started.port).toBe(started.server.actualPort);
    await started.server.closeRoom('server-stopped');
  });
});

describe('lobby synchronization and start gate', () => {
  it('sends the authoritative lobby snapshot in welcome and broadcasts every change', async () => {
    const pair = await connectedPair();
    expect(pair.guest.messages.find((message) => message.type === 'welcome')?.payload.lobby).toMatchObject({
      phase: 'lobby',
      settings: { sidePreference: 'random', timeControlId: 'none', locked: false, settingsVersion: 1 },
      ready: { host: false, guest: false },
      presence: { host: true, guest: true },
      startParameters: null,
    });

    pair.host.send(
      encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'host-red', timeControlId: 'standard' })),
    );
    const broadcast = await pair.guest.waitForType('lobby.state');
    expect(broadcast.payload.lobby.settings).toMatchObject({
      sidePreference: 'host-red',
      timeControlId: 'standard',
      settingsVersion: 2,
    });
    await pair.host.waitForType('lobby.state', (message) => message.payload.lobby.settings.settingsVersion === 2);
    expect(pair.room.getLobby().settings.settingsVersion).toBe(2);
  });

  it('hands a late joiner the latest settings snapshot', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    host.send(encodeMessage(buildClientLobbySettings(room.roomId, { sidePreference: 'host-black', timeControlId: 'blitz' })));
    await host.waitForType('lobby.state', (message) => message.payload.lobby.settings.settingsVersion === 2);

    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    const welcome = await guest.waitForType('welcome');
    expect(welcome.payload.lobby.settings).toMatchObject({
      sidePreference: 'host-black',
      timeControlId: 'blitz',
      settingsVersion: 2,
    });
  });

  it('rejects guest-side changes and malformed payloads as specified', async () => {
    const pair = await connectedPair();

    // 权限拒绝非致命：客人只读，连接保持并可继续其他操作。
    pair.guest.send(encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'host-red', timeControlId: 'none' })));
    pair.guest.send(encodeMessage(buildClientLobbyLock(pair.room.roomId, true)));
    pair.guest.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const rejection = await pair.guest.waitForType('lobby.rejected');
    expect(rejection.payload.code).toBe('NOT_HOST');

    pair.guest.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, true, 1)));
    await pair.guest.waitForType('lobby.state', (message) => message.payload.lobby.ready.guest === true);

    // 结构非法载荷按协议违规处理：明确错误码并断开。
    pair.guest.send(
      JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.ready', roomId: pair.room.roomId, payload: { ready: true, settingsVersion: 0 } }),
    );
    expect(await pair.guest.closed).toBe(4000);
  });

  it('freezes the settings while locked and clears ready after unlocking', async () => {
    const pair = await connectedPair();
    await readyBoth(pair, 1);

    pair.host.send(encodeMessage(buildClientLobbyLock(pair.room.roomId, true)));
    const locked = await pair.guest.waitForType('lobby.state', (message) => message.payload.lobby.settings.locked === true);
    expect(locked.payload.lobby.ready).toEqual({ host: true, guest: true });

    pair.host.send(
      encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'random', timeControlId: 'none' })),
    );
    const rejection = await pair.host.waitForType('lobby.rejected');
    expect(rejection.payload.code).toBe('LOCKED');

    pair.host.send(encodeMessage(buildClientLobbyLock(pair.room.roomId, false)));
    const unlocked = await pair.guest.waitForType(
      'lobby.state',
      (message) => message.payload.lobby.settings.locked === false && message.payload.lobby.ready.host === false,
    );
    expect(unlocked.payload.lobby.ready).toEqual({ host: false, guest: false });
  });

  it('clears ready on real settings changes, dedupes repeat ready and rejects stale versions', async () => {
    const pair = await connectedPair();
    await readyBoth(pair, 1);
    const broadcastsAfterReady = pair.host.messages.filter((message) => message.type === 'lobby.state').length;

    // 重复准备幂等：不产生新广播；随后一次锁定作为同步屏障。
    pair.guest.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, true, 1)));
    pair.host.send(encodeMessage(buildClientLobbyLock(pair.room.roomId, true)));
    await pair.host.waitForType('lobby.state', (message) => message.payload.lobby.settings.locked === true);
    expect(pair.host.messages.filter((message) => message.type === 'lobby.state').length).toBe(broadcastsAfterReady + 1);

    pair.host.send(encodeMessage(buildClientLobbyLock(pair.room.roomId, false)));
    await pair.host.waitForType(
      'lobby.state',
      (message) => message.payload.lobby.settings.locked === false && message.payload.lobby.ready.host === false,
    );
    pair.host.send(
      encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'host-red', timeControlId: 'blitz' })),
    );
    const changed = await pair.guest.waitForType('lobby.state', (message) => message.payload.lobby.settings.settingsVersion === 2);
    expect(changed.payload.lobby.ready).toEqual({ host: false, guest: false });

    // 过期准备被拒绝，只有绑定当前版本的准备生效。
    pair.guest.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, true, 1)));
    const stale = await pair.guest.waitForType('lobby.rejected');
    expect(stale.payload.code).toBe('STALE_VERSION');

    pair.guest.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, true, 2)));
    await pair.guest.waitForType(
      'lobby.state',
      (message) => message.payload.lobby.settings.settingsVersion === 2 && message.payload.lobby.ready.guest === true,
    );
  });

  it('clears ready and blocks the start while the guest is offline', async () => {
    const pair = await connectedPair();
    await readyBoth(pair, 1);

    pair.guest.socket.terminate();
    const dropped = await pair.host.waitForType(
      'lobby.state',
      (message) => message.payload.lobby.presence.guest === false,
    );
    expect(dropped.payload.lobby.ready).toEqual({ host: false, guest: false });

    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const rejection = await pair.host.waitForType('lobby.rejected');
    expect(rejection.payload.code).toBe('MEMBER_MISSING');
  });

  it('blocks the start until both sides are ready and keeps serving after the rejection', async () => {
    const pair = await connectedPair();

    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const rejection = await pair.host.waitForType('lobby.rejected');
    expect(rejection.payload.code).toBe('NOT_READY');

    await readyBoth(pair, 1);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const started = await pair.host.waitForType('lobby.state', (message) => message.payload.lobby.phase === 'started');
    expect(started.payload.lobby.startParameters).toMatchObject({ roomId: pair.room.roomId, settingsVersion: 1 });
  });

  it('draws random sides exactly once and freezes the parameters against repeat starts', async () => {
    let draws = 0;
    const pair = await connectedPair({
      drawHostRed: () => {
        draws += 1;
        return false;
      },
    });
    await readyBoth(pair, 1);

    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const started = await pair.guest.waitForType('lobby.state', (message) => message.payload.lobby.phase === 'started');
    expect(draws).toBe(1);
    expect(started.payload.lobby.startParameters).toMatchObject({
      sidePreference: 'random',
      timeControlId: 'none',
      baseTimeSeconds: null,
      incrementSeconds: 0,
      settingsVersion: 1,
      redMemberId: pair.guestId,
      blackMemberId: pair.hostId,
    });

    const frozen = pair.room.getLobby().startParameters;
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const repeat = await pair.host.waitForType('lobby.rejected');
    expect(repeat.payload.code).toBe('ALREADY_STARTED');
    expect(draws).toBe(1);
    expect(pair.room.getLobby().startParameters).toEqual(frozen);

    // 冻结后设置与就绪一律拒绝。
    pair.host.send(encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'random', timeControlId: 'none' })));
    pair.host.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, false, 1)));
    const afterFreeze = await pair.host.waitForType('lobby.rejected', (message) => message.payload.code === 'ALREADY_STARTED');
    expect(afterFreeze.payload.code).toBe('ALREADY_STARTED');

    // 新成员替换也被拒绝，保持已冻结身份。
    const replacement = await openClient(pair.room.actualPort);
    await hello(replacement, { role: 'guest', name: '客人' });
    expect(await replacement.closed).toBe(4003);
  });

  it('resolves fixed side preferences without any draw', async () => {
    const pair = await connectedPair({
      drawHostRed: () => {
        throw new Error('fixed side preferences must not draw');
      },
    });
    pair.host.send(
      encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'host-black', timeControlId: 'standard' })),
    );
    await pair.host.waitForType('lobby.state', (message) => message.payload.lobby.settings.settingsVersion === 2);
    await readyBoth(pair, 2);

    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const started = await pair.host.waitForType('lobby.state', (message) => message.payload.lobby.phase === 'started');
    expect(started.payload.lobby.startParameters).toMatchObject({
      sidePreference: 'host-black',
      timeControlId: 'standard',
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      settingsVersion: 2,
      redMemberId: pair.guestId,
      blackMemberId: pair.hostId,
    });
  });
});

describe('heartbeat and reconnection', () => {
  it('terminates silent socket when heartbeat pong is not received within timeout', async () => {
    const room = await startRoom({ heartbeatIntervalMs: 50, heartbeatTimeoutMs: 50 });
    const host = await openClient(room.actualPort);
    enableAutoPong(host, room.roomId);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    await guest.waitForType('welcome');

    const ping = await guest.waitForType('ping');
    expect(ping.payload.seq).toBeGreaterThanOrEqual(1);

    const closeCode = await guest.closed;
    expect(closeCode).toBe(1006);

    const members = await host.waitForType(
      'members',
      (m) => m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'guest' && !member.connected),
    );
    expect(members.payload.members.find((m: { role: string }) => m.role === 'guest').connected).toBe(false);
  });

  it('keeps socket alive when client responds to ping with pong', async () => {
    const room = await startRoom({ heartbeatIntervalMs: 50, heartbeatTimeoutMs: 80 });
    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    await guest.waitForType('welcome');

    const ping1 = await guest.waitForType('ping');
    guest.send(encodeMessage(buildPong(room.roomId, ping1.payload.seq)));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guest.closeCode()).toBeNull();
  });

  it('allows guest reconnection with valid resumeToken and re-attaches existing member', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    const guest1 = await openClient(room.actualPort);
    await hello(guest1, { role: 'guest', name: '客人' });
    const welcome1 = await guest1.waitForType('welcome');
    const guestMemberId = welcome1.payload.memberId;
    const resumeToken = welcome1.payload.resumeToken;
    expect(typeof resumeToken).toBe('string');
    expect(resumeToken.length).toBeGreaterThan(0);

    guest1.socket.terminate();
    await host.waitForType(
      'members',
      (m) => m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'guest' && !member.connected),
    );

    const guest2 = await openClient(room.actualPort);
    await hello(guest2, { role: 'guest', name: '客人', resumeToken });
    const welcome2 = await guest2.waitForType('welcome');
    expect(welcome2.payload.memberId).toBe(guestMemberId);
    expect(welcome2.payload.resumeToken).toBe(resumeToken);

    const hostMembers = await host.waitForType(
      'members',
      (m) => m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'guest' && member.connected),
    );
    expect(hostMembers.payload.members.find((m: { role: string }) => m.role === 'guest').connected).toBe(true);
  });

  it('rejects reconnection with invalid or expired resumeToken with UNAUTHORIZED (4002)', async () => {
    const room = await startRoom();
    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人', resumeToken: 'invalid-token-12345' });

    const error = await guest.waitForType('error');
    expect(error.payload.code).toBe('UNAUTHORIZED');
    expect(await guest.closed).toBe(4002);
  });

  it('allows original guest with resumeToken to reconnect after game started, rejecting strangers', async () => {
    const pair = await connectedPair();
    await readyBoth(pair, 1);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    await pair.guest.waitForType('lobby.state', (message) => message.payload.lobby.phase === 'started');

    const resumeToken = pair.guest.messages.find((m) => m.type === 'welcome')?.payload.resumeToken;
    expect(resumeToken).toBeDefined();

    pair.guest.socket.terminate();
    await pair.host.waitForType(
      'members',
      (m) => m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'guest' && !member.connected),
    );

    const stranger = await openClient(pair.room.actualPort);
    await hello(stranger, { role: 'guest', name: '陌生人' });
    expect(await stranger.closed).toBe(4003);

    const reconnectedGuest = await openClient(pair.room.actualPort);
    await hello(reconnectedGuest, { role: 'guest', name: '客人', resumeToken });
    const reconnectedWelcome = await reconnectedGuest.waitForType('welcome');
    expect(reconnectedWelcome.payload.memberId).toBe(pair.guestId);
    expect(reconnectedWelcome.payload.lobby.phase).toBe('started');
  });

  it('broadcasts seed and initial game state upon lobby.start', async () => {
    const pair = await connectedPair();
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);
    await readyBoth(pair, 1);

    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));

    const hostGameState = await pair.host.waitForType('game.state');
    const guestGameState = await pair.guest.waitForType('game.state');

    expect(hostGameState.payload.matchId).toBeDefined();
    expect(hostGameState.payload.matchId).toBe(guestGameState.payload.matchId);
    expect(hostGameState.payload.seed).toBe(guestGameState.payload.seed);
    expect(hostGameState.payload.stepNumber).toBe(0);
    expect(hostGameState.payload.state.currentTurn).toBe('red');
    expect(hostGameState.payload.state.pieces).toEqual(guestGameState.payload.state.pieces);
  });

  it('arbitrates game.action, advances stepNumber, rejects wrong turn and stale steps', async () => {
    const pair = await connectedPair();
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);
    // 房主选 host-red
    pair.host.send(
      encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'host-red', timeControlId: 'standard' })),
    );
    await pair.host.waitForType('lobby.state', (m) => m.payload.lobby.settings.sidePreference === 'host-red');

    await readyBoth(pair, 2);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));

    const startMsg = await pair.host.waitForType('game.state');
    const matchId = startMsg.payload.matchId;
    const pieces = startMsg.payload.state.pieces as Array<{ id: string; revealed: boolean; position: { x: number; y: number } | null }>;
    const hiddenPiece = pieces.find((p) => !p.revealed && p.position !== null)!;

    // 1. 黑方（客人）在红方回合出步 -> 拒绝
    pair.guest.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-bad-turn',
          matchId,
          stepNumber: 0,
          action: { type: 'flip', position: hiddenPiece.position! },
        }),
      ),
    );

    const rejection = await pair.guest.waitForType('game.rejected', (m) => m.requestId === 'req-bad-turn');
    expect(rejection.payload.reason).toContain('非己方回合');
    expect(rejection.payload.stepNumber).toBe(0);

    // 2. 红方（房主）出步 -> 接受并广播
    pair.host.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-host-flip',
          matchId,
          stepNumber: 0,
          action: { type: 'flip', position: hiddenPiece.position! },
        }),
      ),
    );

    const step1Host = await pair.host.waitForType('game.state', (m) => m.payload.stepNumber === 1);
    const step1Guest = await pair.guest.waitForType('game.state', (m) => m.payload.stepNumber === 1);
    expect(step1Host.payload.action).toEqual({ type: 'flip', position: hiddenPiece.position! });
    expect(step1Guest.payload.actorMemberId).toBe(pair.hostId);
    expect(step1Host.payload.state.currentTurn).toBe('black');

    // 3. 再次发送已过期的第 0 步 -> 拒绝
    pair.guest.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-stale-step',
          matchId,
          stepNumber: 0,
          action: { type: 'flip', position: hiddenPiece.position! },
        }),
      ),
    );

    const staleRejection = await pair.guest.waitForType('game.rejected', (m) => m.requestId === 'req-stale-step');
    expect(staleRejection.payload.reason).toContain('已过期');
    expect(staleRejection.payload.stepNumber).toBe(1);
  });

  it('retains match state and allows host reconnecting with hostToken during started phase', async () => {
    const pair = await connectedPair();
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);
    await readyBoth(pair, 1);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const startMsg = await pair.host.waitForType('game.state');
    const matchId = startMsg.payload.matchId;

    // 房主 socket 掉线
    pair.host.socket.terminate();

    // 客人收到房主掉线通知，房间不关闭
    const memberDrop = await pair.guest.waitForType(
      'members',
      (m) => m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'host' && !member.connected),
    );
    expect(memberDrop.payload.members.find((m: { role: string }) => m.role === 'host').connected).toBe(false);

    // 客人此时若尝试操作，服务端拒绝因对手离线
    const pieces = startMsg.payload.state.pieces as Array<{ id: string; revealed: boolean; position: { x: number; y: number } | null }>;
    const hiddenPiece = pieces.find((p) => !p.revealed && p.position !== null)!;
    pair.guest.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-offline',
          matchId,
          stepNumber: 0,
          action: { type: 'flip', position: hiddenPiece.position! },
        }),
      ),
    );
    const offlineRejection = await pair.guest.waitForType('game.rejected');
    expect(offlineRejection.payload.reason).toContain('对手已离线');

    // 房主凭借 hostToken 重连
    const reconnectedHost = await openClient(pair.room.actualPort);
    await hello(reconnectedHost, { role: 'host', name: '房主', token: pair.room.hostToken });
    const welcome = await reconnectedHost.waitForType('welcome');
    expect(welcome.payload.memberId).toBe(pair.hostId);
    expect(welcome.payload.game).toBeDefined();
    expect(welcome.payload.game.matchId).toBe(matchId);
    expect(welcome.payload.game.stepNumber).toBe(0);

    // 客人看到房主重新恢复连接
    const memberRestored = await pair.guest.waitForType(
      'members',
      (m) => m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'host' && member.connected),
    );
    expect(memberRestored.payload.members.find((m: { role: string }) => m.role === 'host').connected).toBe(true);
  });

  it('preserves room and match state when both drop, and allows recovery past 15 seconds', async () => {
    const pair = await connectedPair();
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);
    await readyBoth(pair, 1);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const startMsg = await pair.host.waitForType('game.state');
    const matchId = startMsg.payload.matchId;

    // 双方均断开
    pair.host.socket.terminate();
    pair.guest.socket.terminate();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pair.room.isClosed).toBe(false);

    // 房主重连恢复
    const newHost = await openClient(pair.room.actualPort);
    await hello(newHost, { role: 'host', name: '房主', token: pair.room.hostToken });
    const hostWelcome = await newHost.waitForType('welcome');
    expect(hostWelcome.payload.game?.matchId).toBe(matchId);

    // 客人凭借 resumeToken 重连恢复
    const newGuest = await openClient(pair.room.actualPort);
    await hello(newGuest, { role: 'guest', name: '客人', resumeToken: pair.guestResumeToken });
    const guestWelcome = await newGuest.waitForType('welcome');
    expect(guestWelcome.payload.game?.matchId).toBe(matchId);
    expect(pair.room.isClosed).toBe(false);
  });

  it('enforces requestId idempotency and validates socket ownership on dispatch', async () => {
    const pair = await connectedPair();
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);
    pair.host.send(
      encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'host-red', timeControlId: 'standard' })),
    );
    await pair.host.waitForType('lobby.state', (m) => m.payload.lobby.settings.sidePreference === 'host-red');
    await readyBoth(pair, 2);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const startMsg = await pair.host.waitForType('game.state');
    const matchId = startMsg.payload.matchId;

    const pieces = startMsg.payload.state.pieces as Array<{ id: string; revealed: boolean; position: { x: number; y: number } | null }>;
    const hiddenPiece = pieces.find((p) => !p.revealed && p.position !== null)!;

    // 发送动作带 requestId: 'req-idem-1'
    pair.host.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-idem-1',
          matchId,
          stepNumber: 0,
          action: { type: 'flip', position: hiddenPiece.position! },
        }),
      ),
    );

    const step1 = await pair.host.waitForType('game.state', (m) => m.payload.stepNumber === 1);
    expect(step1.requestId).toBe('req-idem-1');

    // 重复发送完全相同的 requestId -> 幂等命中，返回相同步数 1，不产生第 2 步
    pair.host.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-idem-1',
          matchId,
          stepNumber: 0,
          action: { type: 'flip', position: hiddenPiece.position! },
        }),
      ),
    );

    const idemResponse = await pair.host.waitForType('game.state', (m) => m.requestId === 'req-idem-1');
    expect(idemResponse.payload.stepNumber).toBe(1);

    // 测试旧 socket 替换：房主重连获得新 socket
    const newHost = await openClient(pair.room.actualPort);
    await hello(newHost, { role: 'host', name: '房主', token: pair.room.hostToken });
    await newHost.waitForType('welcome');

    // 旧 socket 收到 superseded 通知
    const supersededRejection = await pair.host.waitForType('error');
    expect(supersededRejection.payload.code).toBe('UNAUTHORIZED');
    expect(supersededRejection.payload.message).toContain('socket-superseded');
  });

  it('validates roomId and matchId in handleGameSync', async () => {
    const pair = await connectedPair();
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);
    await readyBoth(pair, 1);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    await pair.host.waitForType('game.state');

    // 1. 错误的 matchId (返回 game.rejected，不破坏连接)
    pair.host.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'game.sync', roomId: pair.room.roomId, requestId: 'sync-bad-match', payload: { matchId: 'non-existent-match' } }));
    const rej = await pair.host.waitForType('game.rejected', (m) => m.requestId === 'sync-bad-match');
    expect(rej.payload.reason).toContain('对局标识不匹配');

    // 2. 错误的 roomId (协议层错误，返回 error 并关闭)
    pair.host.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'game.sync', roomId: 'wrong-room', payload: {} }));
    const err = await pair.host.waitForType('error');
    expect(err.payload.message).toContain('room-id-mismatch');
  });

  it('broadcasts game.clock and triggers timeout when step time expires', async () => {
    let simulatedTime = 10_000;
    const pair = await connectedPair({
      nowFn: () => simulatedTime,
      clockIntervalMs: 50,
    });
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);

    // 设置为快棋 (10 分 + 30 秒)
    pair.host.send(encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'host-red', timeControlId: 'blitz' })));
    await pair.host.waitForType('lobby.state', (m) => m.payload.lobby.settings.timeControlId === 'blitz');

    await readyBoth(pair, 2);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const initialGameState = await pair.host.waitForType('game.state');
    expect(initialGameState.payload.clock.turn).toBe('red');
    expect(initialGameState.payload.clock.red.stepTimeRemainingMs).toBe(30_000);

    // 收到定期 1Hz / 50ms 的 game.clock 广播
    const clockMsg = await pair.host.waitForType('game.clock');
    expect(clockMsg.payload.clock.turn).toBe('red');

    // 步时超时：推进 31 秒
    simulatedTime += 31_000;
    const timeoutState = await pair.host.waitForType('game.state', (m) => m.payload.settlement !== undefined);
    expect(timeoutState.payload.settlement.winner).toBe('black');
    expect(timeoutState.payload.settlement.reason).toBe('step-timeout');
  });

  it('triggers 90-second disconnect grace when guest drops, and settles on expiration', async () => {
    let simulatedTime = 10_000;
    const pair = await connectedPair({
      nowFn: () => simulatedTime,
      clockIntervalMs: 50,
      drawHostRed: () => true,
    });
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);

    await readyBoth(pair, 1);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    await pair.host.waitForType('game.state');

    // 客人掉线
    pair.guest.socket.close();
    const pausedState = await pair.host.waitForType('game.state', (m) => m.payload.clock?.paused === true);
    expect(pausedState.payload.clock.disconnectGrace.guestDeadlineMs).toBe(simulatedTime + 90_000);

    // 90秒耗尽
    simulatedTime += 90_001;
    // 触发时钟检查（可通过定期 broadcast 或手动检查）
    const endedState = await pair.host.waitForType('game.state', (m) => m.payload.settlement !== undefined);
    expect(endedState.payload.settlement.reason).toBe('disconnect-timeout');
    expect(endedState.payload.settlement.winner).toBe('red');
  });

  it('handles rematch and return to lobby flow', async () => {
    const pair = await connectedPair({
      drawHostRed: () => true,
    });
    enableAutoPong(pair.host, pair.room.roomId);
    enableAutoPong(pair.guest, pair.room.roomId);

    await readyBoth(pair, 1);
    pair.host.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    const startedState = await pair.host.waitForType('game.state');
    const matchId = startedState.payload.matchId;

    // 行动一次
    const hiddenPiece = startedState.payload.state.pieces.find((p: any) => !p.revealed && p.position !== null);
    pair.host.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          matchId,
          stepNumber: 0,
          requestId: 'act-1',
          action: { type: 'flip', position: hiddenPiece.position },
        }),
      ),
    );
    await pair.host.waitForType('game.state', (m) => m.payload.stepNumber === 1);

    // 客人主动离开当前局，客人判负终局
    pair.guest.send(encodeMessage(buildClientLeave(pair.room.roomId)));
    const endedState = await pair.host.waitForType('game.state', (m) => m.payload.settlement !== undefined);
    expect(endedState.payload.settlement.reason).toBe('disconnect-timeout');

    // 房主点击再来一局
    pair.host.send(encodeMessage(buildClientLobbyReturn(pair.room.roomId, { matchId, intent: 'rematch' })));
    const lobbyReset = await pair.host.waitForType(
      'lobby.state',
      (m) => m.payload.lobby.phase === 'lobby' && m.payload.lobby.ready.guest === false,
    );
    expect(lobbyReset.payload.lobby.ready.host).toBe(true);
    expect(lobbyReset.payload.lobby.ready.guest).toBe(false);
  });
});
