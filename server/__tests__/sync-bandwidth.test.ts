// @vitest-environment node
/**
 * 同步出口字节测量（默认跳过，避免常规测试变慢）。
 *
 * 运行：MEASURE_SYNC=1 npx vitest run server/__tests__/sync-bandwidth.test.ts
 *
 * 口径：
 * - 未压缩应用层 JSON 文本字节（Buffer.byteLength(raw, 'utf8')），不冒充 TCP/TLS 流量；
 * - 服务端出口 = 每个实际接收者收到的字节累加（每个客户端各计一份）；
 * - 只统计握手完成后的房间消息，不含 HTTP 认证与 WebSocket 帧开销；
 * - 同一脚本同时适用于 v8（全量巡检）与 v9（增量补丁 + 版本核对），便于前后对比。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RoomServer } from '../room-server';
import { RoomClient, type WebSocketLike } from '../../src/network/client';

interface TypeStats {
  count: number;
  bytes: number;
  max: number;
}

interface SegmentSummary {
  segment: string;
  seconds: number;
  players: number;
  serverToClientBytes: number;
  clientToServerBytes: number;
  serverMessages: Record<string, TypeStats>;
  clientMessages: Record<string, TypeStats>;
}

const enabled = process.env.MEASURE_SYNC === '1';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until(predicate: () => boolean, timeout = 8_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class Meter {
  readonly serverMessages: Record<string, TypeStats> = {};
  readonly clientMessages: Record<string, TypeStats> = {};
  serverToClientBytes = 0;
  clientToServerBytes = 0;

  record(direction: 'server' | 'client', raw: string): void {
    const bytes = Buffer.byteLength(raw, 'utf8');
    let type = 'unparsed';
    try {
      type = String(JSON.parse(raw).type);
    } catch {
      // 保持 unparsed
    }
    const table = direction === 'server' ? this.serverMessages : this.clientMessages;
    const stats = (table[type] ??= { count: 0, bytes: 0, max: 0 });
    stats.count += 1;
    stats.bytes += bytes;
    stats.max = Math.max(stats.max, bytes);
    if (direction === 'server') {
      this.serverToClientBytes += bytes;
    } else {
      this.clientToServerBytes += bytes;
    }
  }

  snapshot(segment: string, since: { server: number; client: number }, startedAt: number, players: number): SegmentSummary {
    return {
      segment,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      players,
      serverToClientBytes: this.serverToClientBytes - since.server,
      clientToServerBytes: this.clientToServerBytes - since.client,
      serverMessages: this.serverMessages,
      clientMessages: this.clientMessages,
    };
  }
}

/** 开始新分段：记录字节起点并清空按类型统计（每段各报各的）。 */
function startSegment(meter: Meter) {
  for (const table of [meter.serverMessages, meter.clientMessages]) {
    for (const key of Object.keys(table)) {
      delete table[key];
    }
  }
  return { server: meter.serverToClientBytes, client: meter.clientToServerBytes };
}

/** 每个客户端一条受控 socket：字节计数 + 可控断线。 */
function meteredFactory(meter: Meter, sockets: WebSocket[]) {
  return (url: string): WebSocketLike => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const facade: WebSocketLike = {
      get readyState() {
        return ws.readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (raw: string) => {
        meter.record('client', raw);
        if (ws.readyState === 1) {
          ws.send(raw);
        }
      },
      close: (code?: number, reason?: string) => ws.close(code, reason),
    };
    ws.on('open', () => facade.onopen?.({}));
    ws.on('message', (raw) => {
      const text = raw.toString();
      meter.record('server', text);
      facade.onmessage?.({ data: text });
    });
    ws.on('close', (code) => facade.onclose?.({ code }));
    ws.on('error', (error) => facade.onerror?.(error));
    return facade;
  };
}

interface Scene {
  server: RoomServer;
  meter: Meter;
  clients: RoomClient[];
  sockets: WebSocket[][];
  host: RoomClient;
  guest: RoomClient;
  spectator: RoomClient;
  start: () => Promise<void>;
  close: () => Promise<void>;
}

async function createScene(clockIntervalMs: number): Promise<Scene> {
  const meter = new Meter();
  const port = await freePort();
  const server = new RoomServer({
    preferredPort: port,
    drawHostRed: () => true,
    drawSeed: () => 42,
    clockIntervalMs,
    logger: () => undefined,
  });
  await server.start();

  const clients: RoomClient[] = [];
  const sockets: WebSocket[][] = [];
  const connect = (role: 'host' | 'guest' | 'spectator', token?: string) => {
    const own: WebSocket[] = [];
    sockets.push(own);
    const client = new RoomClient({
      webSocketFactory: meteredFactory(meter, own),
      reconnectDelays: [50],
    });
    clients.push(client);
    client.connect(
      { host: '127.0.0.1', port },
      { role, name: role, ...(token ? { token } : {}) },
    );
    return client;
  };

  const host = connect('host', server.hostToken);
  await until(() => host.getState().status === 'connected', 8_000, 'host connected');
  const guest = connect('guest');
  const spectator = connect('spectator');
  await until(
    () => clients.every((client) => client.getState().status === 'connected'),
    8_000,
    'all connected',
  );

  const start = async () => {
    host.sendLobbySettings('host-red', 'standard');
    await until(() => guest.getState().lobby?.settings.sidePreference === 'host-red');
    host.sendLobbyReady(true);
    guest.sendLobbyReady(true);
    await until(() => host.getState().lobby?.ready.host === true && host.getState().lobby?.ready.guest === true);
    host.sendLobbyStart();
    await until(() => clients.every((client) => client.getState().game !== null), 8_000, 'game started');
  };

  const close = async () => {
    clients.forEach((client) => client.disconnect());
    sockets.flat().forEach((socket) => socket.terminate());
    if (!server.isClosed) {
      await server.closeRoom('server-stopped');
    }
  };
  cleanups.push(close);

  return { server, meter, clients, sockets, host, guest, spectator, start, close };
}

async function flipOnce(scene: Scene): Promise<void> {
  const game = scene.host.getState().game!;
  const mover = game.gameState.currentTurn === 'red' ? scene.host : scene.guest;
  const before = game.stepNumber;
  const hidden = game.gameState.pieces.find((piece) => !piece.revealed && piece.position);
  mover.sendGameAction({ type: 'flip', position: hidden!.position! });
  await until(() => scene.host.getState().game!.stepNumber === before + 1, 5_000, 'flip applied');
}

function summarize(summary: SegmentSummary): string {
  const row = (table: Record<string, TypeStats>) =>
    Object.entries(table)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([type, stats]) => `${type}:n=${stats.count},b=${stats.bytes},max=${stats.max}`)
      .join(' ');
  return [
    `SEGMENT ${summary.segment} seconds=${summary.seconds} receivers=${summary.players} serverToClientBytes=${summary.serverToClientBytes} clientToServerBytes=${summary.clientToServerBytes}`,
    `  server-to-client ${row(summary.serverMessages)}`,
    `  client-to-server ${row(summary.clientMessages)}`,
  ].join('\n');
}

describe.skipIf(!enabled)('同步出口字节测量', () => {
  it('idle 60s + activity + late join', async () => {
    const idle = await createScene(1_000);
    await idle.start();
    const idleSince = startSegment(idle.meter);
    const idleStartedAt = Date.now();
    // 标准局步时上限为 60 秒，采样窗口取 55 秒，避免把终局结算混进静置样本。
    await new Promise((resolve) => setTimeout(resolve, 55_000));
    console.log(summarize(idle.meter.snapshot('idle-55s', idleSince, idleStartedAt, 3)));
    await idle.close();

    const active = await createScene(1_000);
    await active.start();
    const activeSince = startSegment(active.meter);
    const activeStartedAt = Date.now();

    await flipOnce(active);
    await flipOnce(active);
    await flipOnce(active);

    active.host.sendGameNegotiate('undo');
    await until(() => active.host.getState().game!.pendingNegotiation !== null, 3_000, 'undo pending');
    active.guest.sendGameNegotiateReply(true);
    await until(() => active.host.getState().game!.pendingNegotiation === null, 3_000, 'undo done');

    active.host.sendGameNegotiate('draw');
    await until(() => active.host.getState().game!.pendingNegotiation !== null, 3_000, 'draw pending');
    active.guest.sendGameNegotiateReply(false);
    await until(() => active.host.getState().game!.pendingNegotiation === null, 3_000, 'draw rejected');

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    console.log(summarize(active.meter.snapshot('activity+6s-idle', activeSince, activeStartedAt, 3)));

    const joinSince = startSegment(active.meter);
    const joinStartedAt = Date.now();
    const lateSockets: WebSocket[] = [];
    const late = new RoomClient({
      webSocketFactory: meteredFactory(active.meter, lateSockets),
      reconnectDelays: [50],
    });
    late.connect({ host: '127.0.0.1', port: active.server.actualPort }, { role: 'spectator', name: 'late' });
    await until(() => late.getState().status === 'connected', 5_000, 'late join');
    late.disconnect();
    lateSockets.forEach((socket) => socket.terminate());
    console.log(summarize(active.meter.snapshot('late-join', joinSince, joinStartedAt, 4)));
    await active.close();

    expect(true).toBe(true);
  }, 120_000);
});
