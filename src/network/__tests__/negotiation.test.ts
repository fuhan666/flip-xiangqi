// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RoomServer, type RoomServerOptions } from '../../../server/room-server.js';
import {
  buildClientGameAction,
  buildClientGameNegotiate,
  buildClientGameNegotiateReply,
  buildClientGameResign,
  buildClientHello,
  buildClientLobbyReady,
  buildClientLobbyStart,
  encodeMessage,
} from '../protocol.js';
import {
  parseDrawCooldownUntil,
  parseNegotiationEvent,
  parsePendingNegotiation,
  type PendingNegotiation,
  type NegotiationEvent,
} from '../negotiation.js';
import {
  applyMatchAction,
  createMatch,
  finalizeMatchDraw,
  undoMatchAction,
  type MatchState,
} from '../match.js';

import { createServer, type AddressInfo } from 'node:net';

interface TestClient {
  socket: WebSocket;
  messages: Array<Record<string, any>>;
  waitForType: (type: string, predicate?: (message: Record<string, any>) => boolean) => Promise<Record<string, any>>;
  send: (raw: string) => void;
  close: () => void;
}

const openClients: TestClient[] = [];
const serversToStop: Array<() => Promise<void>> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function openClient(port: number): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<Record<string, any>> = [];
    const waiters: Array<{
      type: string;
      predicate?: (message: Record<string, any>) => boolean;
      resolve: (message: Record<string, any>) => void;
    }> = [];

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

    socket.on('open', () => {
      const client: TestClient = {
        socket,
        messages,
        waitForType: (type, predicate) =>
          new Promise((resolveWait, rejectWait) => {
            const matches = messages.filter((m) => m.type === type && (!predicate || predicate(m)));
            if (matches.length > 0) {
              resolveWait(matches[matches.length - 1]);
              return;
            }
            waiters.push({ type, predicate, resolve: resolveWait });
            setTimeout(() => rejectWait(new Error(`timed out waiting for ${type}`)), 4000);
          }),
        send: (raw) => socket.send(raw),
        close: () => socket.close(),
      };
      openClients.push(client);
      resolve(client);
    });

    socket.on('error', reject);
  });
}

async function startRoom(overrides: Partial<RoomServerOptions> = {}): Promise<RoomServer> {
  const server = new RoomServer({
    preferredPort: await freePort(),
    handshakeTimeoutMs: 1000,
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

afterEach(async () => {
  for (const client of openClients.splice(0, openClients.length)) {
    try {
      client.close();
    } catch {
      // 忽略已关闭连接
    }
  }
  for (const stop of serversToStop.splice(0, serversToStop.length)) {
    await stop();
  }
});

describe('negotiation models and parsers', () => {
  it('parses valid PendingNegotiation and rejects corrupt data', () => {
    const valid: PendingNegotiation = {
      negotiationId: 'neg-1',
      type: 'undo',
      initiatorMemberId: 'm-1',
      responderMemberId: 'm-2',
      baselineRevision: 3,
      createdAt: 1000,
      deadline: 31000,
    };
    expect(parsePendingNegotiation(valid)).toEqual(valid);

    expect(parsePendingNegotiation(null)).toBeNull();
    expect(parsePendingNegotiation({})).toBeNull();
    expect(parsePendingNegotiation({ ...valid, type: 'invalid' })).toBeNull();
    expect(parsePendingNegotiation({ ...valid, negotiationId: '' })).toBeNull();
    expect(parsePendingNegotiation({ ...valid, baselineRevision: -1 })).toBeNull();
    expect(parsePendingNegotiation({ ...valid, deadline: -100 })).toBeNull();
  });

  it('parses valid NegotiationEvent and rejects corrupt data', () => {
    const valid: NegotiationEvent = {
      id: 'evt-1',
      type: 'undo-accepted',
      actorMemberId: 'm-1',
      createdAt: 1000,
      message: '双方同意悔棋，棋局已回退 1 步',
    };
    expect(parseNegotiationEvent(valid)).toEqual(valid);

    expect(parseNegotiationEvent(null)).toBeNull();
    expect(parseNegotiationEvent({ ...valid, type: 'unknown' })).toBeNull();
    expect(parseNegotiationEvent({ ...valid, message: 123 })).toBeNull();
  });

  it('parses drawCooldownUntil map', () => {
    const valid = { 'm-1': 123456, 'm-2': 654321 };
    expect(parseDrawCooldownUntil(valid)).toEqual(valid);
    expect(parseDrawCooldownUntil({ 'm-1': 'invalid' })).toBeNull();
    expect(parseDrawCooldownUntil('not a record')).toBeNull();
  });
});

describe('match domain state rollback and draw finalization', () => {
  function setupTestMatch(): MatchState {
    return createMatch({
      matchId: 'm-1',
      seed: 42,
      initialTime: 1000,
      startParameters: {
        roomId: 'room-1',
        redMemberId: 'host-1',
        blackMemberId: 'guest-1',
        sidePreference: 'host-red',
        timeControlId: 'standard',
        baseTimeSeconds: 1200,
        incrementSeconds: 0,
        settingsVersion: 1,
        players: [
          { role: 'host', side: 'red', name: '房主', memberId: 'host-1' },
          { role: 'guest', side: 'black', name: '客人', memberId: 'guest-1' },
        ],
      },
    });
  }

  it('locks action when pendingNegotiation is active', () => {
    const match = setupTestMatch();
    match.pendingNegotiation = {
      negotiationId: 'neg-1',
      type: 'undo',
      initiatorMemberId: 'host-1',
      responderMemberId: 'guest-1',
      baselineRevision: 0,
      createdAt: 1000,
      deadline: 31000,
    };

    const actionRes = applyMatchAction(match, 'host-1', { type: 'flip', position: { x: 0, y: 3 } }, 1000);
    expect(actionRes.ok).toBe(false);
    if (!actionRes.ok) {
      expect(actionRes.reason).toBe('协商正在进行中，棋盘操作已锁定');
    }
  });

  it('rolls back gameState and clock on undoMatchAction', () => {
    const match = setupTestMatch();
    const hidden = match.gameState.pieces.find((p) => !p.revealed && p.position);
    const firstAction = applyMatchAction(match, 'host-1', { type: 'flip', position: hidden!.position! }, 1000);
    expect(firstAction.ok).toBe(true);
    if (!firstAction.ok) return;
    const movedMatch = firstAction.match;
    expect(movedMatch.stepNumber).toBe(1);

    const undoRes = undoMatchAction(movedMatch);
    expect(undoRes.ok).toBe(true);
    if (!undoRes.ok) return;
    const rolledBack = undoRes.match;
    expect(rolledBack.stepNumber).toBe(0);
    expect(rolledBack.revision).toBe(movedMatch.revision + 1);
  });

  it('finalizes match as draw on finalizeMatchDraw', () => {
    const match = setupTestMatch();
    const drawnMatch = finalizeMatchDraw(match, 'draw-agreement', 5000);
    expect(drawnMatch.settlement).not.toBeNull();
    expect(drawnMatch.settlement?.winner).toBeNull();
    expect(drawnMatch.settlement?.loser).toBeNull();
    expect(drawnMatch.settlement?.reason).toBe('draw-agreement');
  });
});

describe('RoomServer negotiation protocol flows', () => {
  async function setupStartedGame() {
    const server = await startRoom({ drawHostRed: () => true });
    const port = server.actualPort;
    const host = await openClient(port);
    const guest = await openClient(port);

    host.send(encodeMessage(buildClientHello({ role: 'host', name: '房主', token: server.hostToken })));
    const hostWelcome = await host.waitForType('welcome');
    const roomId = hostWelcome.payload.roomId;
    const hostMemberId = hostWelcome.payload.memberId;

    guest.send(encodeMessage(buildClientHello({ role: 'guest', name: '客人', roomId })));
    const guestWelcome = await guest.waitForType('welcome');
    const guestMemberId = guestWelcome.payload.memberId;

    host.send(encodeMessage(buildClientLobbyReady(roomId, true, 1)));
    guest.send(encodeMessage(buildClientLobbyReady(roomId, true, 1)));
    await host.waitForType(
      'lobby.state',
      (m) => m.payload.lobby.ready.host === true && m.payload.lobby.ready.guest === true,
    );

    host.send(encodeMessage(buildClientLobbyStart(roomId)));
    const started = await host.waitForType('game.state');
    await guest.waitForType('game.state');

    return {
      server,
      roomId,
      host,
      guest,
      hostMemberId,
      guestMemberId,
      matchId: started.payload.matchId,
      startedState: started.payload.state,
    };
  }

  it('handles undo negotiation: request -> accept -> rollback step', async () => {
    const { roomId, host, guest, matchId, startedState } = await setupStartedGame();

    const hidden = startedState.pieces.find((p: any) => !p.revealed && p.position);

    // 红方（房主）执行第 0 步翻牌
    host.send(
      encodeMessage(
        buildClientGameAction(roomId, {
          requestId: 'req-1',
          matchId,
          stepNumber: 0,
          revision: 0,
          action: { type: 'flip', position: hidden.position },
        }),
      ),
    );
    const hostState1 = await host.waitForType('game.patch', (m) => m.payload.stepNumber === 1);
    await guest.waitForType('game.patch', (m) => m.payload.stepNumber === 1);

    // 房主发起悔棋协商
    host.send(
      encodeMessage(
        buildClientGameNegotiate(roomId, {
          requestId: 'neg-req-1',
          matchId,
          revision: hostState1.payload.revision,
          kind: 'undo',
        }),
      ),
    );

    // 双方收到 pendingNegotiation 广播
    const negStateHost = await host.waitForType('game.patch', (m) => Boolean(m.payload.changes.pendingNegotiation));
    expect(negStateHost.payload.changes.pendingNegotiation.type).toBe('undo');
    const negStateGuest = await guest.waitForType('game.patch', (m) => Boolean(m.payload.changes.pendingNegotiation));
    const negId = negStateGuest.payload.changes.pendingNegotiation.negotiationId;

    // 客人同意悔棋
    guest.send(
      encodeMessage(
        buildClientGameNegotiateReply(roomId, {
          requestId: 'reply-1',
          matchId,
          negotiationId: negId,
          accept: true,
        }),
      ),
    );

    // 棋局回退至第 0 步，并携带 undo-accepted 事件
    const rolledBackHost = await host.waitForType(
      'game.patch',
      (m) => m.payload.stepNumber === 0 && m.payload.changes.negotiationEvent?.type === 'undo-accepted',
    );
    expect(rolledBackHost.payload.changes.pendingNegotiation).toBeNull();
  });

  it('handles draw negotiation: request -> reject -> cooldown enforcement', async () => {
    const { roomId, host, guest, guestMemberId, matchId } = await setupStartedGame();

    // 客人发起求和
    guest.send(
      encodeMessage(
        buildClientGameNegotiate(roomId, {
          requestId: 'draw-req-1',
          matchId,
          revision: 0,
          kind: 'draw',
        }),
      ),
    );

    const negState = await host.waitForType('game.patch', (m) => m.payload.changes.pendingNegotiation?.type === 'draw');
    const negId = negState.payload.changes.pendingNegotiation.negotiationId;

    // 房主拒绝求和
    host.send(
      encodeMessage(
        buildClientGameNegotiateReply(roomId, {
          requestId: 'reply-draw-1',
          matchId,
          negotiationId: negId,
          accept: false,
        }),
      ),
    );

    // 双方收到 draw-rejected 事件，且客人进入 10 秒冷却
    const rejectedGuest = await guest.waitForType(
      'game.patch',
      (m) => m.payload.changes.negotiationEvent?.type === 'draw-rejected',
    );
    expect(rejectedGuest.payload.changes.drawCooldownUntil[guestMemberId]).toBeGreaterThan(Date.now());

    // 客人在冷却期内再次请求求和 -> 收到 game.rejected
    guest.send(
      encodeMessage(
        buildClientGameNegotiate(roomId, {
          requestId: 'draw-req-2',
          matchId,
          revision: rejectedGuest.payload.revision,
          kind: 'draw',
        }),
      ),
    );
    const rej = await guest.waitForType('game.rejected');
    expect(rej.payload.reason).toContain('求和申请冷却中');
  });

  it('handles resignation: player resigns and match settles', async () => {
    const { roomId, host, guest, matchId } = await setupStartedGame();

    // 客人认输
    guest.send(
      encodeMessage(
        buildClientGameResign(roomId, {
          requestId: 'resign-1',
          matchId,
          revision: 0,
        }),
      ),
    );

    // 房主获胜
    const settled = await host.waitForType('game.patch', (m) => Boolean(m.payload.changes.settlement));
    expect(settled.payload.changes.settlement.winner).toBe('red');
    expect(settled.payload.changes.settlement.loser).toBe('black');
    expect(settled.payload.changes.settlement.reason).toBe('resignation');
    expect(settled.payload.changes.negotiationEvent?.type).toBe('resigned');
  });
});
