// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RoomServer, type RoomServerOptions } from '../room-server';
import {
  buildClientChatPhrase,
  buildClientGameAction,
  buildClientGameNegotiate,
  buildClientGameNegotiateReply,
  buildClientGameResign,
  buildClientGameSync,
  buildClientHello,
  buildClientLeave,
  buildClientLobbyLock,
  buildClientLobbyReady,
  buildClientLobbyReturn,
  buildClientLobbySettings,
  buildClientLobbyStart,
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

interface SpectatorPair {
  room: RoomServer;
  host: TestClient;
  guest: TestClient;
  hostId: string;
  guestId: string;
  matchId: string;
}

/** 两位玩家就绪并开局（host-red + standard 局时），返回对局标识。 */
async function startedPair(): Promise<SpectatorPair> {
  const room = await startRoom();
  const host = await openClient(room.actualPort);
  await hello(host, { role: 'host', name: '房主', token: room.hostToken });
  const hostWelcome = await host.waitForType('welcome');
  const guest = await openClient(room.actualPort);
  await hello(guest, { role: 'guest', name: '客人' });
  const guestWelcome = await guest.waitForType('welcome');

  host.send(encodeMessage(buildClientLobbySettings(room.roomId, { sidePreference: 'host-red', timeControlId: 'standard' })));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.settings.sidePreference === 'host-red');
  host.send(encodeMessage(buildClientLobbyReady(room.roomId, true, 2)));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.ready.host === true);
  guest.send(encodeMessage(buildClientLobbyReady(room.roomId, true, 2)));
  await host.waitForType('lobby.state', (m) => m.payload.lobby.ready.host === true && m.payload.lobby.ready.guest === true);
  host.send(encodeMessage(buildClientLobbyStart(room.roomId)));
  const startMsg = await host.waitForType('game.state');

  return {
    room,
    host,
    guest,
    hostId: hostWelcome.payload.memberId,
    guestId: guestWelcome.payload.memberId,
    matchId: startMsg.payload.matchId,
  };
}

async function joinSpectator(port: number, name = '旁观'): Promise<{ client: TestClient; memberId: string; resumeToken: string }> {
  const client = await openClient(port);
  await hello(client, { role: 'spectator', name });
  const welcome = await client.waitForType('welcome');
  expect(welcome.payload.role).toBe('spectator');
  return {
    client,
    memberId: welcome.payload.memberId,
    resumeToken: welcome.payload.resumeToken,
  };
}

function hiddenPiecePosition(gameState: { pieces: Array<{ revealed: boolean; position: { x: number; y: number } | null }> }): {
  x: number;
  y: number;
} {
  const piece = gameState.pieces.find((p) => !p.revealed && p.position !== null);
  if (!piece || !piece.position) {
    throw new Error('no hidden piece available');
  }
  return piece.position;
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

describe('spectator admission and identity', () => {
  it('never takes a player seat, even while the guest slot is free', async () => {
    const room = await startRoom();
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');

    const spectator = await joinSpectator(room.actualPort);
    expect(room.getMembers().filter((m) => m.role === 'spectator')).toHaveLength(1);

    // 客人席位仍空缺：后续普通加入仍是玩家。
    const guest = await openClient(room.actualPort);
    await hello(guest, { role: 'guest', name: '客人' });
    const guestWelcome = await guest.waitForType('welcome');
    expect(guestWelcome.payload.role).toBe('guest');
    expect(spectator.client.closeCode()).toBeNull();
  });

  it('admits multiple spectators with independent identities and resume tokens', async () => {
    const pair = await startedPair();
    const first = await joinSpectator(pair.room.actualPort);
    const second = await joinSpectator(pair.room.actualPort);

    expect(first.memberId).not.toBe(second.memberId);
    expect(first.resumeToken).toBeDefined();
    expect(second.resumeToken).toBeDefined();
    expect(first.resumeToken).not.toBe(second.resumeToken);

    const members = pair.room.getMembers();
    expect(members.filter((m) => m.role === 'spectator')).toHaveLength(2);
    expect(members.find((m) => m.id === first.memberId)?.connected).toBe(true);

    // 名单广播面向全部在房 socket（含旁观者）。
    const firstSawSecond = await first.client.waitForType('members', (m) =>
      m.payload.members.some((member: { id: string }) => member.id === second.memberId),
    );
    expect(firstSawSecond.payload.members).toHaveLength(4);
  });

  it('rejects cross-identity resume tokens instead of falling back to a fresh member', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);
    const guestResumeToken = pair.guest.messages.find((m) => m.type === 'welcome')?.payload.resumeToken;
    expect(guestResumeToken).toBeDefined();

    // 旁观者凭据不能换身份登录客人席位。
    const fakeGuest = await openClient(pair.room.actualPort);
    await hello(fakeGuest, { role: 'guest', name: '冒充', resumeToken: spectator.resumeToken });
    const guestError = await fakeGuest.waitForType('error');
    expect(guestError.payload.code).toBe('UNAUTHORIZED');
    expect(await fakeGuest.closed).toBe(4002);

    // 客人凭据也不能冒充旁观者。
    const fakeSpectator = await openClient(pair.room.actualPort);
    await hello(fakeSpectator, { role: 'spectator', name: '冒充', resumeToken: guestResumeToken });
    const spectatorError = await fakeSpectator.waitForType('error');
    expect(spectatorError.payload.code).toBe('UNAUTHORIZED');
    expect(await fakeSpectator.closed).toBe(4002);

    // 本人凭据仍可正常恢复。
    const resumed = await openClient(pair.room.actualPort);
    await hello(resumed, { role: 'spectator', name: '旁观', resumeToken: spectator.resumeToken });
    const welcome = await resumed.waitForType('welcome');
    expect(welcome.payload.memberId).toBe(spectator.memberId);
  });
});

describe('read-only enforcement', () => {
  it('rejects every lobby and game action from a spectator with zero side effects', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);

    const matchBefore = pair.room.getMatch()!;
    const revisionBefore = matchBefore.revision;
    const lobbyBefore = pair.room.getLobby();
    const hostGameStatesBefore = pair.host.messages.filter((m) => m.type === 'game.state').length;
    const position = hiddenPiecePosition(matchBefore.gameState);

    spectator.client.send(encodeMessage(buildClientLobbySettings(pair.room.roomId, { sidePreference: 'random', timeControlId: 'none' })));
    spectator.client.send(encodeMessage(buildClientLobbyLock(pair.room.roomId, true)));
    spectator.client.send(encodeMessage(buildClientLobbyReady(pair.room.roomId, false, 2)));
    spectator.client.send(encodeMessage(buildClientLobbyStart(pair.room.roomId)));
    spectator.client.send(encodeMessage(buildClientLobbyReturn(pair.room.roomId, { matchId: pair.matchId, intent: 'rematch' })));
    spectator.client.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'spec-action',
          matchId: pair.matchId,
          stepNumber: 0,
          action: { type: 'flip', position },
        }),
      ),
    );
    spectator.client.send(
      encodeMessage(
        buildClientGameNegotiate(pair.room.roomId, { requestId: 'spec-neg', matchId: pair.matchId, revision: revisionBefore, kind: 'draw' }),
      ),
    );
    spectator.client.send(
      encodeMessage(
        buildClientGameNegotiateReply(pair.room.roomId, {
          requestId: 'spec-neg-reply',
          matchId: pair.matchId,
          negotiationId: 'neg-x',
          accept: true,
        }),
      ),
    );
    spectator.client.send(
      encodeMessage(buildClientGameResign(pair.room.roomId, { requestId: 'spec-resign', matchId: pair.matchId, revision: revisionBefore })),
    );
    spectator.client.send(
      encodeMessage(
        buildClientChatPhrase(pair.room.roomId, { requestId: 'spec-phrase', matchId: pair.matchId, phraseId: 'phrase-greeting-1' }),
      ),
    );

    for (let i = 0; i < 5; i += 1) {
      const rejection = await spectator.client.waitForType('lobby.rejected', (m) => m.payload.code === 'SPECTATOR_READONLY');
      expect(rejection.payload.code).toBe('SPECTATOR_READONLY');
    }
    for (const requestId of ['spec-action', 'spec-neg', 'spec-neg-reply', 'spec-resign']) {
      const rejection = await spectator.client.waitForType('game.rejected', (m) => m.requestId === requestId);
      expect(rejection.payload.reason).toContain('旁观者');
    }
    const phraseRejection = await spectator.client.waitForType('chat.phrase.rejected');
    expect(phraseRejection.payload.code).toBe('NOT_A_PLAYER');

    // 权威对局与大厅零变化：步数、revision、结算、协商、冷却与就绪都不受影响。
    const matchAfter = pair.room.getMatch()!;
    expect(matchAfter.stepNumber).toBe(matchBefore.stepNumber);
    expect(matchAfter.revision).toBe(revisionBefore);
    expect(matchAfter.settlement).toBeNull();
    expect(matchAfter.pendingNegotiation).toBeNull();
    expect(pair.room.getLobby()).toEqual(lobbyBefore);
    // 拒绝只回复请求方：玩家端不新增权威广播。
    expect(pair.host.messages.filter((m) => m.type === 'game.state').length).toBe(hostGameStatesBefore);
    // 连接保持：旁观者不因被拒而掉线。
    expect(spectator.client.closeCode()).toBeNull();
  });

  it('never touches the action cache: a reused requestId still works for a player', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);
    const matchBefore = pair.room.getMatch()!;
    const position = hiddenPiecePosition(matchBefore.gameState);

    spectator.client.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-shared',
          matchId: pair.matchId,
          stepNumber: 0,
          action: { type: 'flip', position },
        }),
      ),
    );
    await spectator.client.waitForType('game.rejected', (m) => m.requestId === 'req-shared');

    pair.host.send(
      encodeMessage(
        buildClientGameAction(pair.room.roomId, {
          requestId: 'req-shared',
          matchId: pair.matchId,
          stepNumber: 0,
          action: { type: 'flip', position },
        }),
      ),
    );
    const advanced = await pair.host.waitForType('game.state', (m) => m.payload.stepNumber === 1);
    expect(advanced.requestId).toBe('req-shared');
  });

  it('serves authoritative game.sync snapshots to spectators', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);

    spectator.client.send(encodeMessage(buildClientGameSync(pair.room.roomId, pair.matchId, 'sync-1')));
    const snapshot = await spectator.client.waitForType('game.state', (m) => m.requestId === 'sync-1');
    expect(snapshot.payload.matchId).toBe(pair.matchId);
    expect(snapshot.payload.stepNumber).toBe(0);
    expect(snapshot.payload.state.pieces).toHaveLength(32);
  });
});

describe('spectator lifecycle', () => {
  it('keeps clock, revision and pending negotiation untouched on spectator drop and resume', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);

    // 无协商时：旁观者掉线不暂停时钟、不改 revision。
    const revisionBefore = pair.room.getMatch()!.revision;
    expect(pair.room.getMatch()!.clock.paused).toBe(false);
    spectator.client.socket.terminate();
    await pair.host.waitForType('members', (m) =>
      m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'spectator' && !member.connected),
    );
    const afterDrop = pair.room.getMatch()!;
    expect(afterDrop.revision).toBe(revisionBefore);
    expect(afterDrop.clock.paused).toBe(false);
    expect(afterDrop.pendingNegotiation).toBeNull();

    // 棋手发起求和协商，再让另一名旁观者掉线：协商不被取消。
    pair.guest.send(
      encodeMessage(
        buildClientGameNegotiate(pair.room.roomId, {
          requestId: 'neg-1',
          matchId: pair.matchId,
          revision: pair.room.getMatch()!.revision,
          kind: 'draw',
        }),
      ),
    );
    await pair.host.waitForType('game.state', (m) => Boolean(m.payload.pendingNegotiation));
    const second = await joinSpectator(pair.room.actualPort);
    const revisionBeforeSecondDrop = pair.room.getMatch()!.revision;
    second.client.socket.terminate();
    await pair.host.waitForType('members', (m) =>
      m.payload.members.some(
        (member: { id: string; connected: boolean }) => member.id === second.memberId && !member.connected,
      ),
    );
    const afterSecondDrop = pair.room.getMatch()!;
    expect(afterSecondDrop.revision).toBe(revisionBeforeSecondDrop);
    expect(afterSecondDrop.pendingNegotiation).not.toBeNull();

    // 断线旁观者凭恢复凭据回到旁观身份，局面不重放。
    const resumed = await openClient(pair.room.actualPort);
    await hello(resumed, { role: 'spectator', name: '旁观', resumeToken: spectator.resumeToken });
    const welcome = await resumed.waitForType('welcome');
    expect(welcome.payload.role).toBe('spectator');
    expect(welcome.payload.memberId).toBe(spectator.memberId);
    expect(welcome.payload.game.stepNumber).toBe(0);
    expect(pair.room.getMatch()!.revision).toBe(revisionBeforeSecondDrop);
    expect(pair.room.getMatch()!.pendingNegotiation).not.toBeNull();
  });

  it('supersedes the old socket when the same spectator resumes', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);

    const resumed = await openClient(pair.room.actualPort);
    await hello(resumed, { role: 'spectator', name: '旁观', resumeToken: spectator.resumeToken });
    await resumed.waitForType('welcome');

    expect(await spectator.client.closed).toBe(4002);
    // 旧 socket 被替换后不再计入在线旁观。
    expect(pair.room.getMembers().filter((m) => m.role === 'spectator' && m.connected)).toHaveLength(1);
  });

  it('revokes resume credentials after an explicit spectator leave', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);

    spectator.client.send(encodeMessage(buildClientLeave(pair.room.roomId)));
    expect(await spectator.client.closed).toBe(1000);
    expect(pair.room.getMembers().some((m) => m.role === 'spectator')).toBe(false);

    const impostor = await openClient(pair.room.actualPort);
    await hello(impostor, { role: 'spectator', name: '旁观', resumeToken: spectator.resumeToken });
    const error = await impostor.waitForType('error');
    expect(error.payload.code).toBe('UNAUTHORIZED');
    expect(await impostor.closed).toBe(4002);
  });

  it('expires dropped spectators after the resume window', async () => {
    const room = await startRoom({ spectatorResumeWindowMs: 30 });
    const host = await openClient(room.actualPort);
    await hello(host, { role: 'host', name: '房主', token: room.hostToken });
    await host.waitForType('welcome');
    const spectator = await joinSpectator(room.actualPort);

    spectator.client.socket.terminate();
    await host.waitForType('members', (m) =>
      m.payload.members.some((member: { role: string; connected: boolean }) => member.role === 'spectator' && !member.connected),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(room.getMembers().some((m) => m.role === 'spectator')).toBe(false);
  });

  it('notifies spectators when the room closes', async () => {
    const pair = await startedPair();
    const spectator = await joinSpectator(pair.room.actualPort);

    await pair.room.closeRoom('host-closed');
    const notice = await spectator.client.waitForType('room.closed');
    expect(notice.payload.reason).toBe('host-closed');
    expect(await spectator.client.closed).toBe(4004);
  });

  it('counts player seats and online spectators for the room summary', async () => {
    const pair = await startedPair();
    const first = await joinSpectator(pair.room.actualPort);
    const second = await joinSpectator(pair.room.actualPort);

    const summarize = () => {
      const members = pair.room.getMembers();
      return {
        playerCount: members.filter((m) => m.role !== 'spectator').length,
        spectatorCount: members.filter((m) => m.role === 'spectator' && m.connected).length,
      };
    };

    expect(summarize()).toEqual({ playerCount: 2, spectatorCount: 2 });

    second.client.socket.terminate();
    await first.client.waitForType('members', (m) =>
      m.payload.members.some((member: { id: string; connected: boolean }) => member.id === second.memberId && !member.connected),
    );
    // 掉线旁观者保留恢复记录但不计入在线旁观数。
    expect(summarize()).toEqual({ playerCount: 2, spectatorCount: 1 });
    expect(pair.room.getMembers().filter((m) => m.role === 'spectator')).toHaveLength(2);
  });
});
