// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RoomServerError, RoomServer, startRoomServer, type RoomServerOptions } from '../room-server';
import {
  buildClientHello,
  buildClientLeave,
  buildClientLobbyLock,
  buildClientLobbyReady,
  buildClientLobbySettings,
  buildClientLobbyStart,
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
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function occupyPort(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    // 与房间监听同样绑定 0.0.0.0，确保端口占用真实冲突。
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
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
    const preferredPort = await freePort();
    const blocker = await occupyPort(preferredPort);
    const room = await startRoom({ preferredPort, maxPortAttempts: 3 });

    expect(room.actualPort).toBe(preferredPort + 1);
    await room.closeRoom('server-stopped');
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('reports PORT_UNAVAILABLE when the attempts are exhausted', async () => {
    const preferredPort = await freePort();
    const blocker = await occupyPort(preferredPort);
    const room = new RoomServer({ preferredPort, maxPortAttempts: 1, logger: () => undefined });

    await expect(room.start()).rejects.toMatchObject({ code: 'PORT_UNAVAILABLE' });
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
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
  interface ConnectedPair {
    room: RoomServer;
    host: TestClient;
    guest: TestClient;
    hostId: string;
    guestId: string;
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
