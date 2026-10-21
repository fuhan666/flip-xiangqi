// @vitest-environment node
/**
 * 增量同步端到端回归：真实会话 + 公开补丁应用器，不上监听端口。
 *
 * 覆盖验收点：
 * - 常规动作/协商/结算只发补丁，开局与显式同步才发完整公开快照；
 * - 5 秒巡检（game.version）与 1Hz 计时广播都不构造完整公开投影；
 * - 漏包、乱序、重复、旧会话与协商/结算遗漏后仍能收敛；
 * - 悔棋降步数但修订继续前进，旧版本请求不被接纳；
 * - 重复动作只回精简回执，不重播旧效果。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSession, type RoomSessionOptions, type SessionConnection } from '../room-session';
import { asConnectionId, generateId, type ConnectionId } from '../room-identity';
import {
  buildClientChatPhrase,
  buildClientGameAction,
  buildClientGameNegotiate,
  buildClientGameNegotiateReply,
  buildClientGameSync,
  buildClientGameVersion,
  buildClientHello,
  buildClientLobbyReady,
  buildClientLobbyStart,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
} from '../../src/network/protocol';
import { applyPublicGameDelta } from '../../src/network/public-patch';
import type { MatchEvent, MatchSettlement } from '../../src/network/match.js';
import type { NegotiationEvent, PendingNegotiation } from '../../src/network/negotiation.js';
import type { PublicGameState } from '../../src/network/public-game.js';
import {
  publicProjectionCounters,
  resetPublicProjectionCounters,
} from '../public-view';

type AnyMessage = Record<string, any>;

class FakeConnection implements SessionConnection {
  readonly connectionId: ConnectionId = asConnectionId(generateId());
  readonly sent: AnyMessage[] = [];
  closeCode: number | null = null;

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  close(code: number, reason: string): void {
    this.closeCode = code;
    void reason;
  }

  messages(type: string, predicate?: (message: AnyMessage) => boolean): AnyMessage[] {
    return this.sent.filter((message) => message.type === type && (!predicate || predicate(message)));
  }

  last(type: string, predicate?: (message: AnyMessage) => boolean): AnyMessage | null {
    const matches = this.messages(type, predicate);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }
}

class FakeClock {
  now = 10_000;
  readonly nowFn = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
    vi.advanceTimersByTime(ms);
  }
}

/** 客户端镜像：只按 game.patch / game.state 还原公开状态，用于校验增量等价性。 */
class Mirror {
  revision = 0;
  stepNumber = 0;
  gameState: PublicGameState;
  matchEvents: MatchEvent[] = [];
  settlement: MatchSettlement | null = null;
  pendingNegotiation: PendingNegotiation | null = null;
  negotiationEvent: NegotiationEvent | null = null;
  drawCooldownUntil: Record<string, number> = {};
  phraseCooldownUntil: Record<string, number> = {};
  patches = 0;
  snapshots = 0;
  gaps = 0;

  constructor(stateMessage: AnyMessage) {
    const payload = stateMessage.payload;
    this.revision = payload.revision;
    this.stepNumber = payload.stepNumber;
    this.gameState = payload.state;
    this.matchEvents = payload.matchEvents ?? [];
    this.settlement = payload.settlement ?? null;
    this.pendingNegotiation = payload.pendingNegotiation ?? null;
    this.negotiationEvent = payload.negotiationEvent ?? null;
    this.drawCooldownUntil = payload.drawCooldownUntil ?? {};
    this.phraseCooldownUntil = payload.phraseCooldownUntil ?? {};
    this.snapshots += 1;
  }

  apply(message: AnyMessage): 'applied' | 'ignored' | 'gap' | 'invalid' {
    if (message.type === 'game.state') {
      this.revision = message.payload.revision;
      this.stepNumber = message.payload.stepNumber;
      this.gameState = message.payload.state;
      this.matchEvents = message.payload.matchEvents ?? [];
      this.settlement = message.payload.settlement ?? null;
      this.pendingNegotiation = message.payload.pendingNegotiation ?? null;
      this.negotiationEvent = message.payload.negotiationEvent ?? null;
      this.drawCooldownUntil = message.payload.drawCooldownUntil ?? {};
      this.phraseCooldownUntil = message.payload.phraseCooldownUntil ?? {};
      this.snapshots += 1;
      return 'applied';
    }
    const patch = message.payload;
    if (patch.revision <= this.revision) {
      return 'ignored';
    }
    if (patch.baseRevision !== this.revision) {
      this.gaps += 1;
      return 'gap';
    }
    const applied = applyPublicGameDelta(this.gameState, this.matchEvents, patch.changes);
    if (!applied.ok) {
      this.gaps += 1;
      return 'invalid';
    }
    this.gameState = applied.gameState;
    this.matchEvents = applied.matchEvents;
    this.revision = patch.revision;
    this.stepNumber = patch.stepNumber;
    if (patch.changes.settlement !== undefined) this.settlement = patch.changes.settlement;
    if (patch.changes.pendingNegotiation !== undefined) this.pendingNegotiation = patch.changes.pendingNegotiation;
    if (patch.changes.negotiationEvent !== undefined) this.negotiationEvent = patch.changes.negotiationEvent;
    if (patch.changes.drawCooldownUntil) this.drawCooldownUntil = patch.changes.drawCooldownUntil;
    if (patch.changes.phraseCooldownUntil) this.phraseCooldownUntil = patch.changes.phraseCooldownUntil;
    this.patches += 1;
    return 'applied';
  }
}

function deliver(session: RoomSession, connection: FakeConnection, message: ClientMessage): void {
  const parsed = parseClientMessage(encodeMessage(message));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    session.handleMessage(connection.connectionId, parsed.message);
  }
}

function createSession(overrides: Partial<RoomSessionOptions> = {}) {
  const clock = new FakeClock();
  const session = new RoomSession({
    nowFn: clock.nowFn,
    drawHostRed: () => true,
    drawSeed: () => 42,
    clockIntervalMs: 250,
    logger: () => undefined,
    ...overrides,
  });
  return { session, clock };
}

function startGame(options: Partial<RoomSessionOptions> = {}) {
  vi.useFakeTimers();
  const { session, clock } = createSession(options);
  const host = new FakeConnection();
  session.attach(host);
  deliver(session, host, buildClientHello({ role: 'host', name: '房主', token: session.hostToken, roomId: session.roomId }));
  const guest = new FakeConnection();
  session.attach(guest);
  const guestWelcome = (() => {
    deliver(session, guest, buildClientHello({ role: 'guest', name: '客人', roomId: session.roomId }));
    return guest.last('welcome')!;
  })();
  deliver(session, host, buildClientLobbyReady(session.roomId, true, 1));
  deliver(session, guest, buildClientLobbyReady(session.roomId, true, 1));
  deliver(session, host, buildClientLobbyStart(session.roomId));
  const bootstrap = host.last('game.state')!;
  const matchId = bootstrap.payload.matchId;
  return { session, clock, host, guest, guestMemberId: guestWelcome.payload.memberId, matchId, bootstrap };
}

function action(session: RoomSession, actor: FakeConnection, matchId: string, requestId: string, position?: { x: number; y: number }) {
  const match = session.getMatch()!;
  const hidden = position ?? match.gameState.pieces.find((piece) => !piece.revealed && piece.position !== null)!.position!;
  deliver(
    session,
    actor,
    buildClientGameAction(session.roomId, {
      requestId,
      matchId,
      stepNumber: match.stepNumber,
      revision: match.revision,
      action: { type: 'flip', position: hidden },
    }),
  );
}

function drain(mirrors: Map<FakeConnection, Mirror>, connections: FakeConnection[], cursors: Map<FakeConnection, number>) {
  for (const connection of connections) {
    const mirror = mirrors.get(connection)!;
    const from = cursors.get(connection) ?? 0;
    for (const message of connection.sent.slice(from)) {
      if (message.type === 'game.patch' || message.type === 'game.state') {
        const result = mirror.apply(message);
        expect(result, `message ${message.type} at revision ${message.payload.revision}`).not.toBe('invalid');
      }
    }
    cursors.set(connection, connection.sent.length);
  }
}

afterEach(() => {
  vi.useRealTimers();
  resetPublicProjectionCounters();
});

describe('增量同步', () => {
  it('开局后常规动作、协商与结算只发补丁，镜像与权威投影逐步一致', () => {
    const { session, host, guest, matchId, bootstrap } = startGame();
    const cursors = new Map<FakeConnection, number>([
      [host, host.sent.length],
      [guest, guest.sent.length],
    ]);
    const mirrors = new Map<FakeConnection, Mirror>([
      [host, new Mirror(bootstrap)],
      [guest, new Mirror(guest.last('game.state')!)],
    ]);
    const connections = [host, guest];

    action(session, host, matchId, 'f-1');
    drain(mirrors, connections, cursors);
    expect(host.messages('game.patch')).toHaveLength(1);
    expect(host.messages('game.state')).toHaveLength(1);

    action(session, guest, matchId, 'f-2');
    drain(mirrors, connections, cursors);
    action(session, host, matchId, 'f-3');
    drain(mirrors, connections, cursors);

    // 悔棋：申请 → 同意，步数下降而修订继续前进。
    const revisionBeforeUndo = session.getMatch()!.revision;
    deliver(session, guest, buildClientGameNegotiate(session.roomId, {
      requestId: 'neg-1',
      matchId,
      revision: revisionBeforeUndo,
      kind: 'undo',
    }));
    drain(mirrors, connections, cursors);
    const pending = session.getMatch()!.pendingNegotiation!;
    deliver(session, host, buildClientGameNegotiateReply(session.roomId, {
      requestId: 'neg-reply-1',
      matchId,
      negotiationId: pending.negotiationId,
      accept: true,
    }));
    drain(mirrors, connections, cursors);

    const undone = session.getPublicMatch()!;
    for (const mirror of mirrors.values()) {
      expect(mirror.revision).toBe(undone.revision);
      expect(mirror.stepNumber).toBe(undone.stepNumber);
      expect(mirror.stepNumber).toBe(2);
      expect(mirror.gameState).toEqual(undone.gameState);
      expect(mirror.matchEvents).toEqual(undone.matchEvents);
      expect(mirror.pendingNegotiation).toBeNull();
    }

    // 全程只有开局那一次完整快照，其余都是补丁。
    expect(host.messages('game.state')).toHaveLength(1);
    expect(host.messages('game.patch').length).toBeGreaterThanOrEqual(5);
  });

  it('悔棋后同一步号的旧版本动作被拒绝，不会重复执行', () => {
    const { session, host, guest, matchId } = startGame();
    action(session, host, matchId, 'f-1');
    const revisionAfterFlip = session.getMatch()!.revision;
    deliver(session, host, buildClientGameNegotiate(session.roomId, {
      requestId: 'neg-u',
      matchId,
      revision: revisionAfterFlip,
      kind: 'undo',
    }));
    const pending = session.getMatch()!.pendingNegotiation!;
    deliver(session, guest, buildClientGameNegotiateReply(session.roomId, {
      requestId: 'neg-u-reply',
      matchId,
      negotiationId: pending.negotiationId,
      accept: true,
    }));
    expect(session.getMatch()!.stepNumber).toBe(0);

    // 悔棋前的同一动作带旧 revision 重放：步数相同但版本已过期。
    const hidden = session.getMatch()!.gameState.pieces.find((piece) => !piece.revealed && piece.position !== null)!.position!;
    const revisionAfterUndo = session.getMatch()!.revision;
    deliver(session, host, buildClientGameAction(session.roomId, {
      requestId: 'replay-old',
      matchId,
      stepNumber: 0,
      revision: revisionAfterFlip,
      action: { type: 'flip', position: hidden },
    }));
    const rejected = host.last('game.rejected', (message) => message.requestId === 'replay-old')!;
    expect(rejected.payload.reason).toContain('操作版本已过期');
    expect(rejected.payload.revision).toBe(revisionAfterUndo);
    expect(rejected.payload).not.toHaveProperty('state');
    expect(session.getMatch()!.stepNumber).toBe(0);
  });

  it('重复动作只回精简回执，其他连接不收到重复广播', () => {
    const { session, host, guest, matchId } = startGame();
    action(session, host, matchId, 'dup-1');
    const guestBefore = guest.sent.length;
    const hostBefore = host.sent.length;
    action(session, host, matchId, 'dup-1');
    expect(guest.sent.slice(guestBefore)).toHaveLength(0);
    const receipt = host.sent.slice(hostBefore).find((message) => message.type === 'game.receipt')!;
    expect(receipt).toBeTruthy();
    expect(receipt.payload.acceptedStepNumber).toBe(1);
    expect(receipt.payload.stepNumber).toBe(1);
    expect(receipt.payload).not.toHaveProperty('state');
    expect(session.getMatch()!.stepNumber).toBe(1);
  });

  it('game.version 只回版本号：不构造完整投影，也不下发棋盘', () => {
    const { session, host } = startGame();
    resetPublicProjectionCounters();
    deliver(session, host, buildClientGameVersion(session.roomId, {
      requestId: 'v-1',
      matchId: session.getMatch()!.matchId,
      revision: session.getMatch()!.revision,
    }));
    const reply = host.last('game.version')!;
    expect(reply.requestId).toBe('v-1');
    expect(reply.payload).toEqual({
      matchId: session.getMatch()!.matchId,
      revision: session.getMatch()!.revision,
    });
    expect(publicProjectionCounters.matchSnapshot).toBe(0);
    expect(publicProjectionCounters.gameState).toBe(0);
    expect(host.sent.at(-1)!.type).toBe('game.version');
  });

  it('1Hz 计时广播不构造完整棋局快照', () => {
    const { clock, host } = startGame();
    const before = host.sent.length;
    resetPublicProjectionCounters();
    clock.advance(1_000);
    const messages = host.sent.slice(before);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.type === 'game.clock')).toBe(true);
    expect(publicProjectionCounters.matchSnapshot).toBe(0);
    expect(publicProjectionCounters.gameState).toBe(0);
  });

  it('短语冷却推进版本并发布小补丁，可被版本核对发现', () => {
    const { session, host, guest, matchId } = startGame();
    const revisionBefore = session.getMatch()!.revision;
    deliver(session, host, buildClientChatPhrase(session.roomId, {
      requestId: 'phrase-1',
      matchId,
      phraseId: 'phrase-greeting-1',
    }));
    expect(session.getMatch()!.revision).toBe(revisionBefore + 1);
    const patch = guest.last('game.patch')!;
    expect(patch.payload.revision).toBe(revisionBefore + 1);
    const hostId = session.getMembers().find((member) => member.role === 'host')!.id;
    expect(patch.payload.changes.phraseCooldownUntil[hostId]).toBeGreaterThan(0);
    // 短语本身仍走独立的即时广播。
    expect(guest.last('chat.phrase')).not.toBeNull();
  });

  it('漏掉一个补丁后镜像检测到缺口，显式同步立即补齐', () => {
    const { session, host, guest, matchId, bootstrap } = startGame();
    const mirror = new Mirror(bootstrap);
    const from = host.sent.length;
    action(session, host, matchId, 'g-1');
    action(session, guest, matchId, 'g-2');
    const messages = host.sent.slice(from).filter((message) => message.type === 'game.patch');
    expect(messages).toHaveLength(2);
    expect(mirror.apply(messages[0])).toBe('applied');
    // 跳过第二个补丁：再来的新补丁基线不衔接，必须报缺口而不是猜一步。
    action(session, host, matchId, 'g-3');
    const third = host.last('game.patch', (message) => message.payload.stepNumber === 3)!;
    expect(mirror.apply(third)).toBe('gap');
    expect(mirror.revision).toBe(1);

    deliver(session, host, buildClientGameSync(session.roomId, matchId, 'sync-repair'));
    const repaired = host.last('game.state', (message) => message.requestId === 'sync-repair')!;
    expect(mirror.apply(repaired)).toBe('applied');
    expect(mirror.revision).toBe(session.getMatch()!.revision);
    expect(mirror.gameState.actionHistory).toHaveLength(3);
  });

  it('重复与更旧的补丁被忽略，不改变镜像', () => {
    const { session, host, matchId, bootstrap } = startGame();
    const mirror = new Mirror(bootstrap);
    const from = host.sent.length;
    action(session, host, matchId, 'o-1');
    const patch = host.sent.slice(from).find((message) => message.type === 'game.patch')!;
    expect(mirror.apply(patch)).toBe('applied');
    const revision = mirror.revision;
    expect(mirror.apply(patch)).toBe('ignored');
    expect(mirror.revision).toBe(revision);
  });

  it('同步单播不改变全房间补丁基线，后续补丁仍可从旧基线应用', () => {
    const { session, host, guest, matchId, bootstrap } = startGame();
    const mirror = new Mirror(bootstrap);
    const guestMirror = new Mirror(guest.last('game.state')!);
    action(session, host, matchId, 'b-1');
    deliver(session, guest, buildClientGameSync(session.roomId, matchId, 'sync-1'));
    const synced = guest.last('game.state', (message) => message.requestId === 'sync-1')!;
    expect(guestMirror.apply(synced)).toBe('applied');
    action(session, guest, matchId, 'b-2');
    const nextPatch = host.last('game.patch')!;
    // 基线来自全房间发布序列，而不是单播同步。
    expect(nextPatch.payload.baseRevision).toBe(1);
    expect(mirror.apply(host.sent.filter((message) => message.type === 'game.patch')[0])).toBe('applied');
    expect(mirror.apply(nextPatch)).toBe('applied');
    expect(mirror.gameState).toEqual(session.getPublicMatch()!.gameState);
  });
});
