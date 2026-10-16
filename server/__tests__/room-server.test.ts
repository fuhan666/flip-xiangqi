// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RoomServerError, RoomServer, startRoomServer, type RoomServerOptions } from '../room-server';
import {
  buildClientHello,
  buildClientLeave,
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
