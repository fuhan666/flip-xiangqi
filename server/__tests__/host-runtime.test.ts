// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { HostRuntime, isLoopbackAddress } from '../host-runtime';
import {
  buildClientHello,
  encodeMessage,
  parseServerMessage,
  type ServerMessage,
} from '../../src/network/protocol';

const runtimes: HostRuntime[] = [];
const blockers: Server[] = [];

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
    server.listen(port, '0.0.0.0', () => {
      blockers.push(server);
      resolve(server);
    });
  });
}

async function startRuntime(): Promise<{ runtime: HostRuntime; base: string; roomPort: number }> {
  const uiPort = await freePort();
  const roomPort = await freePort();
  const runtime = new HostRuntime({
    uiPort,
    roomPort,
    dev: false,
    staticDir: 'dist',
    logger: () => undefined,
  });
  await runtime.start();
  runtimes.push(runtime);
  return { runtime, base: `http://127.0.0.1:${uiPort}`, roomPort };
}

async function postJson(base: string, path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}

async function getJson(base: string, path: string): Promise<Record<string, any>> {
  const response = await fetch(`${base}${path}`);
  return (await response.json()) as Record<string, any>;
}

function joinAsGuest(port: number, roomId: string): Promise<{ socket: WebSocket; welcome: ServerMessage }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on('error', reject);
    socket.on('open', () => {
      socket.send(encodeMessage(buildClientHello({ role: 'guest', name: '客人', roomId })));
    });
    socket.on('message', (data) => {
      const parsed = parseServerMessage(data.toString());
      if (parsed.ok && parsed.message.type === 'welcome') {
        resolve({ socket, welcome: parsed.message });
      }
    });
    setTimeout(() => reject(new Error('guest join timed out')), 3000);
  });
}

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()?.stop();
  }
  while (blockers.length > 0) {
    await new Promise<void>((resolve) => blockers.pop()?.close(() => resolve()));
  }
});

describe('loopback enforcement', () => {
  it('accepts loopback addresses and rejects LAN addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.7')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('control api', () => {
  it('reports host availability and the default room port', async () => {
    const { base, roomPort } = await startRuntime();
    const status = await getJson(base, '/api/room/status');

    expect(status).toMatchObject({ ok: true, hostAvailable: true, defaultRoomPort: roomPort, active: false, room: null });
  });

  it('creates a room with an address list and a host token', async () => {
    const { base, roomPort } = await startRuntime();
    const created = await postJson(base, '/api/room/create', {});

    expect(created.ok).toBe(true);
    expect(created.roomId).toEqual(expect.any(String));
    expect(created.hostToken).toEqual(expect.any(String));
    expect(created.port).toBe(roomPort);
    expect(Array.isArray(created.addresses)).toBe(true);
    expect(created.loopbackOnly).toEqual(expect.any(Boolean));

    // 客人可以凭地址加入该房间。
    const guest = await joinAsGuest(created.port, created.roomId);
    expect(guest.welcome.type).toBe('welcome');
    guest.socket.terminate();
  });

  it('returns the same room for repeated create clicks without extra listeners', async () => {
    const { base } = await startRuntime();
    const first = await postJson(base, '/api/room/create', {});
    const second = await postJson(base, '/api/room/create', {});

    expect(second.roomId).toBe(first.roomId);
    expect(second.port).toBe(first.port);
    expect(second.hostToken).toBe(first.hostToken);
  });

  it('rejects invalid port configuration with an actionable message', async () => {
    const { base } = await startRuntime();
    const result = await postJson(base, '/api/room/create', { port: 70_000 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_PORT');
    expect(result.message).toContain('70000');
  });

  it('falls back to the next port when the preferred one is busy', async () => {
    const { base, roomPort } = await startRuntime();
    await occupyPort(roomPort);

    const created = await postJson(base, '/api/room/create', {});
    expect(created.ok).toBe(true);
    expect(created.port).toBe(roomPort + 1);
  });

  it('only accepts control requests from the loopback interface', async () => {
    const { base } = await startRuntime();
    const response = await fetch(`${base}/api/room/status`, {
      headers: { 'x-forwarded-for': '192.168.1.7' },
    });
    // 远端地址即本机：请求被接受；来源判定只看 socket 远端地址，不信任代理头。
    expect(response.status).toBe(200);
  });
});

describe('room lifecycle through the control api', () => {
  it('closes the room only with the correct host token', async () => {
    const { base } = await startRuntime();
    const created = await postJson(base, '/api/room/create', {});

    const wrong = await postJson(base, '/api/room/close', { hostToken: 'forged' });
    expect(wrong.ok).toBe(false);
    expect(wrong.code).toBe('UNAUTHORIZED');

    const guest = await joinAsGuest(created.port, created.roomId);
    const closedNotice = new Promise<ServerMessage>((resolve) => {
      guest.socket.on('message', (data) => {
        const parsed = parseServerMessage(data.toString());
        if (parsed.ok && parsed.message.type === 'room.closed') {
          resolve(parsed.message);
        }
      });
    });

    const ok = await postJson(base, '/api/room/close', { hostToken: created.hostToken });
    expect(ok.ok).toBe(true);

    const notice = await closedNotice;
    expect(notice.type === 'room.closed' && notice.payload.reason).toBe('host-closed');

    const closingAgain = await postJson(base, '/api/room/close', { hostToken: created.hostToken });
    expect(closingAgain.ok).toBe(false);
    expect(closingAgain.code).toBe('ROOM_CLOSED');
  });

  it('keeps control endpoints off the guest-facing room port', async () => {
    const { base } = await startRuntime();
    const created = await postJson(base, '/api/room/create', {});

    const controlOverLan = await fetch(`http://127.0.0.1:${created.port}/api/room/create`, { method: 'POST', body: '{}' });
    expect(controlOverLan.status).toBe(404);

    const statusOverLan = await fetch(`http://127.0.0.1:${created.port}/api/room/status`);
    expect(statusOverLan.status).toBe(200);
    expect(await statusOverLan.json()).toMatchObject({ ok: false, hostAvailable: false, roomPage: true });

    const guestMarker = await fetch(`http://127.0.0.1:${created.port}/api/guest`);
    expect(guestMarker.status).toBe(200);
    expect(await guestMarker.json()).toMatchObject({ ok: true, roomPage: true });

    const markerOnControl = await fetch(`${base}/api/guest`);
    expect(markerOnControl.status).toBe(200);
    expect(await markerOnControl.json()).toMatchObject({ ok: false, roomPage: false });
  });
});
