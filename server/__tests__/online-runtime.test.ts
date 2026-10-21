// @vitest-environment node
/**
 * 在线入口端到端：单一 HTTPS/WSS 地址、多个匿名房间、真实 cookie 与真实协议消息。
 * 断言对象是真实返回码与出站消息，不以「抛错即通过」代替拒绝路径。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RoomClient, type ConnectionState } from '../../src/network/client';
import { validateMove } from '../../src/game/move-rules';
import type { RoomSession } from '../room-session';
import { OnlineRuntime, OnlineRuntimeError } from '../online-runtime';
import { testTls } from './helpers/tls';
import {
  RawRoomSocket,
  callApi,
  collectKeys,
  createRoom,
  onlineSocketFactory,
  openSession,
  startOnlineRuntime,
  until,
  type TrafficEntry,
} from './helpers/online-harness';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Player {
  cookie: string;
  client: RoomClient;
  traffic: TrafficEntry[];
}

async function startRuntime(): Promise<OnlineRuntime> {
  const runtime = await startOnlineRuntime();
  cleanups.push(() => runtime.stop());
  return runtime;
}

async function newPlayer(runtime: OnlineRuntime): Promise<Player> {
  const cookie = await openSession(runtime.port);
  const traffic: TrafficEntry[] = [];
  const client = new RoomClient({
    onlineOrigin: runtime.publicOrigin,
    webSocketFactory: onlineSocketFactory(cookie, traffic, runtime.publicOrigin),
  });
  cleanups.push(() => client.disconnect(false));
  return { cookie, client, traffic };
}

async function join(player: Player, roomId: string): Promise<ConnectionState> {
  player.client.connectOnline(roomId);
  try {
    await until(() => player.client.getState().status === 'connected', 5_000);
  } catch (error) {
    throw new Error(`join failed: ${JSON.stringify(player.client.getState())}`);
  }
  return player.client.getState();
}

function roomSession(runtime: OnlineRuntime, roomId: string): RoomSession {
  const session = runtime.getRoom(roomId);
  if (!session) {
    throw new Error('room missing');
  }
  return session;
}

function hiddenPosition(session: RoomSession): { x: number; y: number } {
  const piece = session.getMatch()!.gameState.pieces.find((item) => !item.revealed && !item.captured && item.position);
  if (!piece?.position) {
    throw new Error('no hidden piece');
  }
  return piece.position;
}

function legalMoveFor(session: RoomSession, role: 'host' | 'guest') {
  const match = session.getMatch()!;
  const side = match.startParameters.players.find((player) => player.role === role)!.side;
  if (match.gameState.currentTurn !== side) {
    return null;
  }
  for (const piece of match.gameState.pieces) {
    if (!piece.revealed || piece.captured || piece.camp !== side || !piece.position) {
      continue;
    }
    for (let x = 0; x < 9; x += 1) {
      for (let y = 0; y < 10; y += 1) {
        if (x === piece.position.x && y === piece.position.y) {
          continue;
        }
        if (validateMove(match.gameState, piece, { x, y }).ok) {
          return { type: 'move' as const, from: piece.position, to: { x, y } };
        }
      }
    }
  }
  return null;
}

async function startMatch(host: Player, guest: Player): Promise<void> {
  host.client.sendLobbySettings('host-red', 'standard');
  await until(() => guest.client.getState().lobby?.settings.sidePreference === 'host-red');
  host.client.sendLobbyReady(true);
  guest.client.sendLobbyReady(true);
  await until(
    () =>
      host.client.getState().lobby?.ready.host === true &&
      host.client.getState().lobby?.ready.guest === true,
  );
  host.client.sendLobbyStart();
  await until(() => host.client.getState().game !== null && guest.client.getState().game !== null, 5_000);
  expect(host.client.getState().lobby?.phase).toBe('started');
}

async function settledBoth(host: Player, guest: Player, step: number): Promise<void> {
  await until(
    () =>
      host.client.getState().game?.stepNumber === step &&
      guest.client.getState().game?.stepNumber === step &&
      host.client.getState().game?.pendingAction === null,
    5_000,
  );
}

describe('在线入口：单一地址多房间', () => {
  it('同一公网地址上两个房间独立完成对战，动作与结算互不串房', async () => {
    const runtime = await startRuntime();
    const port = runtime.port;

    const hostA = await newPlayer(runtime);
    const guestA = await newPlayer(runtime);
    const hostB = await newPlayer(runtime);
    const guestB = await newPlayer(runtime);

    const roomA = (await createRoom(port, hostA.cookie, 'create-a')).json!;
    const roomB = (await createRoom(port, hostB.cookie, 'create-b')).json!;
    expect(roomA.ok).toBe(true);
    expect(roomB.ok).toBe(true);
    expect(roomA.roomId).not.toBe(roomB.roomId);
    expect(roomA.url).toBe(`${runtime.publicOrigin}/online/rooms/${roomA.roomId}`);
    // 邀请链接只含公开房间号。
    expect(roomA.url).not.toMatch(/token|key|secret|identity/i);

    const welcomeHostA = await join(hostA, roomA.roomId);
    const welcomeGuestA = await join(guestA, roomA.roomId);
    const welcomeHostB = await join(hostB, roomB.roomId);
    const welcomeGuestB = await join(guestB, roomB.roomId);
    expect(welcomeHostA.role).toBe('host');
    expect(welcomeGuestA.role).toBe('guest');
    expect(welcomeHostB.role).toBe('host');
    expect(welcomeGuestB.role).toBe('guest');
    expect(welcomeHostA.roomId).toBe(roomA.roomId);

    await startMatch(hostA, guestA);
    await startMatch(hostB, guestB);

    const sessionA = roomSession(runtime, roomA.roomId);
    const sessionB = roomSession(runtime, roomB.roomId);
    const matchIdA = hostA.client.getState().game!.matchId;
    const matchIdB = hostB.client.getState().game!.matchId;
    expect(matchIdA).not.toBe(matchIdB);

    const bRevisionBefore = sessionB.getPublicMatch()!.revision;
    const bStepBefore = sessionB.getPublicMatch()!.stepNumber;

    // A 房：翻牌 → 翻牌 → 走子 → 认输结算。
    hostA.client.sendGameAction({ type: 'flip', position: hiddenPosition(sessionA) });
    await settledBoth(hostA, guestA, 1);
    guestA.client.sendGameAction({ type: 'flip', position: hiddenPosition(sessionA) });
    await settledBoth(hostA, guestA, 2);

    const move = legalMoveFor(sessionA, 'host');
    expect(move).not.toBeNull();
    hostA.client.sendGameAction(move!);
    await settledBoth(hostA, guestA, 3);

    guestA.client.sendGameResign();
    await until(() => sessionA.getPublicMatch()!.settlement !== null, 3_000);
    await until(
      () =>
        hostA.client.getState().game?.settlement != null &&
        guestA.client.getState().game?.settlement != null,
      3_000,
    );
    expect(hostA.client.getState().game!.settlement!.winner).toBeTruthy();

    // B 房完全没被 A 房的动作影响。
    expect(sessionB.getPublicMatch()!.revision).toBe(bRevisionBefore);
    expect(sessionB.getPublicMatch()!.stepNumber).toBe(bStepBefore);
    expect(sessionB.getPublicMatch()!.settlement).toBeNull();

    // B 房独立完成：认输结算。
    guestB.client.sendGameResign();
    await until(() => sessionB.getPublicMatch()!.settlement !== null, 3_000);
    await until(() => hostB.client.getState().game?.settlement != null, 3_000);
    expect(hostB.client.getState().game!.settlement!.winner).toBeTruthy();

    // A 房的结算不改变 B 房的成员与房间号。
    expect(hostB.client.getState().roomId).toBe(roomB.roomId);
    expect(sessionB.getMembers().map((member) => member.role)).toEqual(['host', 'guest']);
  }, 30_000);

  it('跨房消息、伪造身份与越权动作都被拒绝且不改变任何房间状态', async () => {
    const runtime = await startRuntime();
    const port = runtime.port;

    const hostA = await newPlayer(runtime);
    const guestA = await newPlayer(runtime);
    const hostB = await newPlayer(runtime);

    const roomA = (await createRoom(port, hostA.cookie, 'a')).json!;
    const roomB = (await createRoom(port, hostB.cookie, 'b')).json!;
    await join(hostA, roomA.roomId);
    await join(guestA, roomA.roomId);
    await join(hostB, roomB.roomId);
    await startMatch(hostA, guestA);

    const sessionA = roomSession(runtime, roomA.roomId);
    const sessionB = roomSession(runtime, roomB.roomId);
    const revisionA = sessionA.getPublicMatch()!.revision;
    // B 房还没开局：跨房动作不能让它凭空得到对局。
    expect(sessionB.getPublicMatch()).toBeNull();
    expect(sessionB.getLobbyPhase()).toBe('lobby');

    // 客人越权：修改房主设置与开始对局，都被服务端拒绝。
    guestA.client.sendLobbySettings('host-black', 'blitz');
    await until(() => guestA.client.getState().lastRejection !== null, 2_000);
    guestA.client.sendLobbyStart();
    expect(sessionA.getLobby().settings.sidePreference).toBe('host-red');
    expect(sessionA.getLobby().settings.timeControlId).toBe('standard');

    // 新匿名身份持 A 房链接：只能得到服务器授权的旁观席位。
    const intruder = await newPlayer(runtime);
    const intruderWelcome = await join(intruder, roomA.roomId);
    expect(intruderWelcome.role).toBe('spectator');
    expect(intruder.client.getState().memberId).not.toBe(hostA.client.getState().memberId);
    expect(intruder.client.getState().memberId).not.toBe(guestA.client.getState().memberId);

    // 旁观者用真实 socket 发跨房动作与写动作：服务端逐条拒绝，B 房与 A 房都不改变。
    const watcherCookie = await openSession(port);
    const watcher = await RawRoomSocket.open(port, roomA.roomId, { cookie: watcherCookie });
    watcher.send({ version: 10, type: 'online.hello', roomId: roomA.roomId, payload: {} });
    await until(() => watcher.last('welcome') !== null, 2_000);
    expect(watcher.last('welcome')!.payload.role).toBe('spectator');

    watcher.send({
      version: 10,
      type: 'game.action',
      requestId: 'spectator-write',
      roomId: roomA.roomId,
      payload: {
        matchId: sessionA.getPublicMatch()!.matchId,
        stepNumber: sessionA.getPublicMatch()!.stepNumber,
        revision: sessionA.getPublicMatch()!.revision,
        action: { type: 'flip', position: { x: 0, y: 6 } },
      },
    });
    await until(() => watcher.last('game.rejected') !== null, 2_000);

    // 另一个房间的玩家连接：信封指向 A 房的心跳与动作都被房间绑定拒绝。
    const foreignCookie = await openSession(port);
    const foreignRoom = (await createRoom(port, foreignCookie, 'foreign')).json!;
    const foreign = await RawRoomSocket.open(port, foreignRoom.roomId, { cookie: foreignCookie });
    foreign.send({ version: 10, type: 'online.hello', roomId: foreignRoom.roomId, payload: {} });
    await until(() => foreign.last('welcome') !== null, 2_000);
    expect(foreign.last('welcome')!.payload.role).toBe('host');

    // 心跳被拒后连接按协议关闭（4000），不能继续复用。
    foreign.send({ version: 10, type: 'ping', roomId: roomA.roomId, payload: { seq: 1 } });
    await until(() => foreign.last('error') !== null, 2_000);
    expect(foreign.last('error')!.payload.message).toBe('room-id-mismatch');
    await until(() => foreign.closed !== null, 2_000);
    expect(foreign.closed!.code).toBe(4000);

    // 换一条新连接，用同一玩家身份尝试把动作投到 A 房，同样被房间绑定拒绝。
    const foreign2 = await RawRoomSocket.open(port, foreignRoom.roomId, { cookie: foreignCookie });
    foreign2.send({ version: 10, type: 'online.hello', roomId: foreignRoom.roomId, payload: {} });
    await until(() => foreign2.last('welcome') !== null, 2_000);
    foreign2.send({
      version: 10,
      type: 'game.action',
      requestId: 'cross-room-action',
      roomId: roomA.roomId,
      payload: {
        matchId: sessionA.getPublicMatch()!.matchId,
        stepNumber: sessionA.getPublicMatch()!.stepNumber,
        revision: sessionA.getPublicMatch()!.revision,
        action: { type: 'flip', position: { x: 0, y: 6 } },
      },
    });
    await until(() => foreign2.last('error') !== null, 2_000);
    expect(foreign2.last('error')!.payload.message).toBe('room-id-mismatch');
    foreign2.close();

    // 伪造身份：通过 HTTP 直接提交角色字段不参与准入（身份只来自 cookie）。
    const forgedRole = await callApi(port, '/api/online/rooms', {
      body: { requestId: 'forged', identityId: hostA.client.getState().memberId, role: 'host' },
      cookie: watcherCookie,
    });
    expect(forgedRole.status).toBe(200);
    expect(forgedRole.json!.roomId).not.toBe(roomA.roomId);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sessionB.getPublicMatch()).toBeNull();
    expect(sessionB.getLobbyPhase()).toBe('lobby');
    expect(sessionA.getPublicMatch()!.revision).toBe(revisionA);
    expect(sessionA.getPublicMatch()!.stepNumber).toBe(0);
    expect(sessionB.getMembers().some((member) => member.id === intruder.client.getState().memberId)).toBe(false);
    watcher.close();
  }, 30_000);

  it('握手与 API 的拒绝矩阵：无凭据、坏 Origin、未知房间、LAN 入口与非法载荷', async () => {
    const runtime = await startRuntime();
    const port = runtime.port;

    const host = await newPlayer(runtime);
    const room = (await createRoom(port, host.cookie, 'r')).json!;
    await join(host, room.roomId);

    // --- HTTP API ---
    const noCookie = await callApi(port, '/api/online/rooms', { body: { requestId: 'x' } });
    expect(noCookie.status).toBe(401);

    const badOrigin = await callApi(port, '/api/online/rooms', {
      body: { requestId: 'x' },
      cookie: host.cookie,
      origin: 'https://evil.example',
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.json?.code).toBe('BAD_ORIGIN');

    const forgedSession = await callApi(port, '/api/online/session', {
      body: {},
      cookie: '__Host-flip_anon=FORGEDFORGEDFORGEDFORGEDFORGEDFORGEDFORGEDFORGED',
    });
    expect(forgedSession.status).toBe(401);
    expect(forgedSession.json?.code).toBe('SESSION_INVALID');

    for (const lanPath of ['/api/room/status', '/api/room/create', '/api/guest']) {
      const response = await callApi(port, lanPath, { body: {} });
      expect(response.status).toBe(404);
      expect(response.json?.code).toBe('LAN_CONTROL_UNAVAILABLE');
    }

    const missingRequestId = await callApi(port, '/api/online/rooms', { body: {}, cookie: host.cookie });
    expect(missingRequestId.status).toBe(400);

    // --- WSS 握手 ---
    await expect(RawRoomSocket.open(port, room.roomId, { cookie: null })).rejects.toThrow('upgrade-rejected:401');
    await expect(
      RawRoomSocket.open(port, room.roomId, { cookie: host.cookie, origin: 'https://evil.example' }),
    ).rejects.toThrow('upgrade-rejected:403');
    await expect(RawRoomSocket.open(port, 'unknown-room-id', { cookie: host.cookie })).rejects.toThrow(
      'upgrade-rejected:404',
    );

    // --- 非法载荷 ---
    const lanHello = await RawRoomSocket.open(port, room.roomId, { cookie: host.cookie });
    lanHello.send({ version: 10, type: 'hello', roomId: room.roomId, payload: { role: 'host', name: 'x' } });
    await until(() => lanHello.last('error') !== null, 2_000);
    expect(lanHello.last('error')?.payload.message).toBe('lan-hello-not-allowed');
    lanHello.close();

    const forgedIdentity = await RawRoomSocket.open(port, room.roomId, { cookie: host.cookie });
    forgedIdentity.send({
      version: 10,
      type: 'online.hello',
      roomId: room.roomId,
      payload: { role: 'host', memberId: 'forged' },
    });
    await until(() => forgedIdentity.last('error') !== null, 2_000);
    expect(forgedIdentity.last('error')?.payload.code).toBe('INVALID_MESSAGE');
    expect(forgedIdentity.last('error')?.payload.message).toBe('online-hello-payload');
    forgedIdentity.close();

    // --- 心跳的跨房门禁 ---
    const crossRoomPing = await RawRoomSocket.open(port, room.roomId, { cookie: host.cookie });
    crossRoomPing.send({ version: 10, type: 'online.hello', roomId: room.roomId, payload: {} });
    await until(() => crossRoomPing.last('welcome') !== null, 2_000);
    crossRoomPing.send({ version: 10, type: 'ping', roomId: 'another-room', payload: { seq: 1 } });
    await until(() => crossRoomPing.last('error') !== null, 2_000);
    expect(crossRoomPing.last('error')?.payload.message).toBe('room-id-mismatch');
    crossRoomPing.close();
  }, 30_000);

  it('建房幂等：同键并发与重试只得一个房间，关闭后不复活', async () => {
    const runtime = await startRuntime();
    const port = runtime.port;

    const host = await newPlayer(runtime);
    const other = await newPlayer(runtime);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createRoom(port, host.cookie, 'same-request')),
    );
    const roomIds = new Set(results.map((result) => result.json!.roomId));
    expect(roomIds.size).toBe(1);
    expect(results.filter((result) => result.json!.created === true)).toHaveLength(1);
    expect(runtime.roomCount).toBe(1);

    const retry = await createRoom(port, host.cookie, 'same-request');
    expect(retry.json!.roomId).toBe([...roomIds][0]);
    expect(retry.json!.created).toBe(false);

    // 不同身份的同名 requestId 相互隔离。
    const isolated = await createRoom(port, other.cookie, 'same-request');
    expect(isolated.json!.roomId).not.toBe([...roomIds][0]);
    expect(runtime.roomCount).toBe(2);

    // 建房者显式关房；同键重试返回同一房间且标记已关闭，不产生新房间。
    const roomId = [...roomIds][0] as string;
    const closed = await callApi(port, `/api/online/rooms/${roomId}/close`, { body: {}, cookie: host.cookie });
    expect(closed.status).toBe(200);
    expect(runtime.getRoom(roomId)).toBeNull();
    expect(runtime.roomCount).toBe(1);

    const afterClose = await createRoom(port, host.cookie, 'same-request');
    expect(afterClose.json!.roomId).toBe(roomId);
    expect(afterClose.json!.created).toBe(false);
    expect(afterClose.json!.closed).toBe(true);
    expect(runtime.roomCount).toBe(1);

    // 非建房者不能关闭他人房间。
    const denied = await callApi(port, `/api/online/rooms/${isolated.json!.roomId}/close`, {
      body: {},
      cookie: host.cookie,
    });
    expect(denied.status).toBe(403);
  }, 30_000);

  it('刷新重连凭 cookie 恢复原成员，连接标识独立；关闭单房不影响共享监听器', async () => {
    const runtime = await startRuntime();
    const port = runtime.port;

    const host = await newPlayer(runtime);
    const guest = await newPlayer(runtime);
    const room = (await createRoom(port, host.cookie, 'reconnect')).json!;

    await join(host, room.roomId);
    await join(guest, room.roomId);
    const original = host.client.getState();
    expect(original.role).toBe('host');

    // 刷新：只释放传输，不发主动离开。
    host.client.disconnect(false);
    await until(() => host.client.getState().status === 'disconnected');

    const reopened = new RoomClient({
      onlineOrigin: runtime.publicOrigin,
      webSocketFactory: onlineSocketFactory(host.cookie, host.traffic, runtime.publicOrigin),
    });
    cleanups.push(() => reopened.disconnect(false));
    reopened.connectOnline(room.roomId);
    await until(() => reopened.getState().status === 'connected', 5_000);
    expect(reopened.getState().memberId).toBe(original.memberId);
    expect(reopened.getState().role).toBe('host');
    expect(runtime.getRoom(room.roomId)!.getMembers()).toHaveLength(2);

    // 关闭 A 房后监听器仍在，可创建并加入新房间。
    const closed = await callApi(port, `/api/online/rooms/${room.roomId}/close`, { body: {}, cookie: host.cookie });
    expect(closed.status).toBe(200);
    await until(() => reopened.getState().status !== 'connected', 3_000);

    const newHost = await newPlayer(runtime);
    const second = (await createRoom(port, newHost.cookie, 'second')).json!;
    await join(newHost, second.roomId);
    expect(newHost.client.getState().role).toBe('host');
    expect(newHost.client.getState().roomId).toBe(second.roomId);

    // stop 幂等并释放监听器与凭据。
    await runtime.stop();
    await runtime.stop();
    await expect(callApi(port, '/api/online/session', { body: {} })).rejects.toBeTruthy();
  }, 30_000);

  it('出站消息不含任何控制/重连密钥与内部棋局数据', async () => {
    const runtime = await startRuntime();
    const port = runtime.port;

    const host = await newPlayer(runtime);
    const guest = await newPlayer(runtime);
    const room = (await createRoom(port, host.cookie, 'secret-scan')).json!;
    await join(host, room.roomId);
    await join(guest, room.roomId);
    await startMatch(host, guest);

    host.client.sendGameAction({ type: 'flip', position: hiddenPosition(roomSession(runtime, room.roomId)) });
    await settledBoth(host, guest, 1);

    const keys = collectKeys([host.traffic, guest.traffic]);
    for (const forbidden of [
      'hostToken',
      'resumeToken',
      'identityId',
      'seed',
      'initial',
      'publicPieceIds',
      'undoStack',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }

    // 服务端只下发公开投影：消息里没有暗子身份（hidden piece 的 camp/type）。
    for (const entry of [...host.traffic, ...guest.traffic]) {
      if (entry.message.type !== 'welcome' && entry.message.type !== 'game.state') {
        continue;
      }
      const state = entry.message.payload?.game?.gameState ?? entry.message.payload?.state;
      if (!state?.pieces) {
        continue;
      }
      for (const piece of state.pieces) {
        if (piece.revealed !== true) {
          expect(piece.camp).toBeUndefined();
          expect(piece.type).toBeUndefined();
        }
      }
    }
  }, 30_000);
});

describe('在线入口启动配置', () => {
  it('缺少 TLS 证书或使用 http 来源时直接失败，不回退 HTTP', () => {
    expect(() => new OnlineRuntime({ port: 0, publicOrigin: 'https://localhost:8443', tls: { key: '', cert: '' } })).toThrow(
      OnlineRuntimeError,
    );
    expect(
      () =>
        new OnlineRuntime({
          port: 0,
          publicOrigin: 'http://localhost',
          tls: testTls(),
        }),
    ).toThrow(OnlineRuntimeError);
  });

  it('监听地址与端口来自配置，实际端口可查询', async () => {
    const runtime = await startOnlineRuntime();
    const address = runtime.port;
    expect(address).toBeGreaterThan(0);
    const response = await callApi(address, '/api/online/session', { body: {}, method: 'GET', origin: null });
    expect(response.status).toBe(401);
    await runtime.stop();
  });
});
