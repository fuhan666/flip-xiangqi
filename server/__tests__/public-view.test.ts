// @vitest-environment node
/**
 * 公开棋局边界回归：
 * - 所有发包路径（开局广播、动作确认、拒绝、重复请求、同步、旁观拒绝、welcome）共用同一公开投影；
 * - 未翻棋子只暴露位置与不透明标识，种子/开局/撤销/内部 ID/身份顺序均不出现在线协议里；
 * - 同一公开布局下，暗子身份置换与内部数组顺序打乱不改变序列化结果；
 * - 只有本房间已握手且为席位当前连接的成员收到广播。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSession, type RoomSessionOptions, type SessionConnection } from '../room-session';
import { asConnectionId, generateId, type ConnectionId } from '../room-identity';
import { projectGameState, projectMatchSnapshot } from '../public-view';
import {
  buildClientGameAction,
  buildClientGameNegotiate,
  buildClientGameNegotiateReply,
  buildClientGameSync,
  buildClientHello,
  buildClientLobbyReady,
  buildClientLobbyStart,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
} from '../../src/network/protocol';
import { buildStartParameters } from '../../src/network/lobby';
import { applyMatchAction, createMatch, undoMatchAction } from '../../src/network/match';
import { validateMove } from '../../src/game/move-rules';
import type { Piece } from '../../src/game/types';

type AnyMessage = Record<string, any>;

class FakeConnection implements SessionConnection {
  readonly connectionId: ConnectionId = asConnectionId(generateId());
  readonly sent: AnyMessage[] = [];
  closeCode: number | null = null;

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  close(code: number): void {
    if (this.closeCode === null) {
      this.closeCode = code;
    }
  }

  messages(type: string): AnyMessage[] {
    return this.sent.filter((message) => message.type === type);
  }

  last(type: string): AnyMessage | null {
    const matches = this.messages(type);
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

const START_PARAMETERS = buildStartParameters({
  roomId: 'room-1',
  host: { memberId: 'host-1', name: '房主' },
  guest: { memberId: 'guest-1', name: '客人' },
  settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
  hostSide: 'red',
});

function makeMatch(seed = 42): ReturnType<typeof createMatch> {
  return createMatch({
    matchId: `match-${seed}`,
    seed,
    startParameters: START_PARAMETERS,
    publicIdFactory: (index) => `t${index.toString(36)}`,
  });
}

function createSession(overrides: Partial<RoomSessionOptions> = {}): { session: RoomSession; clock: FakeClock } {
  const clock = new FakeClock();
  const session = new RoomSession({
    nowFn: clock.nowFn,
    drawHostRed: () => true,
    drawSeed: () => 42,
    clockIntervalMs: 60_000,
    randomToken: (() => {
      let seq = 0;
      return () => `tok-${(seq += 1)}`;
    })(),
    logger: () => undefined,
    ...overrides,
  });
  return { session, clock };
}

function deliver(session: RoomSession, connection: FakeConnection, message: ClientMessage): void {
  const parsed = parseClientMessage(encodeMessage(message));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    session.handleMessage(connection.connectionId, parsed.message);
  }
}

function hello(
  session: RoomSession,
  connection: FakeConnection,
  payload: { role: 'host' | 'guest' | 'spectator'; name: string; token?: string; resumeToken?: string },
): AnyMessage {
  deliver(session, connection, buildClientHello({ ...payload, roomId: session.roomId }));
  expect(connection.last('welcome')).not.toBeNull();
  return connection.last('welcome')!;
}

function startMatch(): {
  session: RoomSession;
  clock: FakeClock;
  host: FakeConnection;
  guest: FakeConnection;
  matchId: string;
} {
  vi.useFakeTimers();
  const { session, clock } = createSession();
  const host = new FakeConnection();
  session.attach(host);
  hello(session, host, { role: 'host', name: '房主', token: session.hostToken });
  const guest = new FakeConnection();
  session.attach(guest);
  hello(session, guest, { role: 'guest', name: '客人' });
  deliver(session, host, buildClientLobbyReady(session.roomId, true, 1));
  deliver(session, guest, buildClientLobbyReady(session.roomId, true, 1));
  deliver(session, host, buildClientLobbyStart(session.roomId));
  const state = host.last('game.state')!;
  expect(state).not.toBeNull();
  return { session, clock, host, guest, matchId: state.payload.matchId };
}

function flip(session: RoomSession, actor: FakeConnection, matchId: string, requestId: string): void {
  const match = session.getMatch()!;
  const hidden = match.gameState.pieces.find((piece) => !piece.revealed && piece.position !== null)!;
  deliver(
    session,
    actor,
    buildClientGameAction(session.roomId, {
      requestId,
      matchId,
      stepNumber: match.stepNumber,
      revision: match.revision,
      action: { type: 'flip', position: hidden.position! },
    }),
  );
}

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

const FORBIDDEN_KEYS = ['seed', 'initial', 'undoStack', 'publicPieceIds', 'confirmedState', 'displayState'];

function expectNoSecretKeys(payload: unknown): void {
  const keys = collectKeys(payload);
  for (const key of FORBIDDEN_KEYS) {
    expect(keys, `出站载荷不应包含 ${key}`).not.toContain(key);
  }
  expect(JSON.stringify(payload)).not.toMatch(/(black|red)-(king|rook|cannon|horse|elephant|advisor|pawn)-/);
}

function expectHiddenPiecesAreOpaque(state: AnyMessage['payload']['state'] | AnyMessage['payload']['changes']['pieces']): void {
  const pieces = Array.isArray(state) ? state : state.pieces;
  for (const piece of pieces) {
    if (piece.revealed) {
      continue;
    }
    expect(Object.keys(piece).sort()).toEqual(['id', 'position', 'revealed']);
    expect(piece.position).not.toBeNull();
  }
}

describe('统一公开投影', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开局、动作确认、拒绝、重复请求、同步与旁观拒绝都给出同一公开形状', () => {
    const { session, host, guest, matchId } = startMatch();

    const start = host.last('game.state')!;
    expectNoSecretKeys(start.payload);
    expectHiddenPiecesAreOpaque(start.payload.state);

    // 动作确认：常规走棋只发公开补丁，不再广播整份棋局。
    flip(session, host, matchId, 'req-1');
    const confirmed = host.last('game.patch')!;
    expect(confirmed).not.toBeNull();
    expect(host.last('game.state')).toBe(start);
    expectNoSecretKeys(confirmed.payload);
    expectHiddenPiecesAreOpaque(confirmed.payload.changes.pieces ?? []);
    expect(confirmed.payload.revision).toBeGreaterThan(start.payload.revision);
    expect(confirmed.payload.baseRevision).toBe(start.payload.revision);
    expect(confirmed.payload.stepNumber).toBe(1);

    // 重复请求：只回精简回执给请求者，其他连接不重复接收任何棋局消息
    const hostBefore = host.sent.length;
    flip(session, guest, matchId, 'req-dup');
    expect(host.sent.length).toBeGreaterThan(hostBefore);
    const replayBefore = guest.sent.length;
    const hostReplayBefore = host.sent.length;
    flip(session, guest, matchId, 'req-dup');
    const dup = guest.sent.slice(replayBefore).filter((message) => message.type === 'game.receipt');
    expect(dup).toHaveLength(1);
    expect(host.sent.slice(hostReplayBefore)).toHaveLength(0);
    expectNoSecretKeys(dup[0].payload);
    expect(dup[0].payload).not.toHaveProperty('state');

    // 拒绝也只给权威版本，不夹带棋局
    deliver(
      session,
      host,
      buildClientGameAction(session.roomId, {
        requestId: 'req-reject',
        matchId,
        stepNumber: 0,
        action: { type: 'flip', position: { x: 4, y: 4 } },
      }),
    );
    const rejected = host.last('game.rejected')!;
    expect(rejected).not.toBeNull();
    expectNoSecretKeys(rejected.payload);
    expect(rejected.payload).not.toHaveProperty('state');

    // 显式同步
    deliver(session, guest, buildClientGameSync(session.roomId, matchId));
    const sync = guest.last('game.state')!;
    expectNoSecretKeys(sync.payload);
    expectHiddenPiecesAreOpaque(sync.payload.state);

    // 旁观者 welcome 与拒绝
    const spectator = new FakeConnection();
    session.attach(spectator);
    const welcome = hello(session, spectator, { role: 'spectator', name: '观' });
    expect(welcome.payload.game).toBeTruthy();
    expectNoSecretKeys(welcome.payload.game);
    expectHiddenPiecesAreOpaque(welcome.payload.game.gameState);
    deliver(
      session,
      spectator,
      buildClientGameAction(session.roomId, {
        requestId: 'spec-1',
        matchId,
        stepNumber: session.getMatch()!.stepNumber,
        action: { type: 'flip', position: { x: 0, y: 0 } },
      }),
    );
    const specRejected = spectator.last('game.rejected');
    expect(specRejected).not.toBeNull();
    expectNoSecretKeys(specRejected!.payload);
    expect(specRejected!.payload).not.toHaveProperty('state');
  });

  it('未握手连接收不到任何棋局或大厅广播，握手后才收到正确公开快照', () => {
    const { session, host, matchId } = startMatch();
    const lurker = new FakeConnection();
    session.attach(lurker);

    flip(session, host, matchId, 'req-lurker');
    expect(lurker.sent).toHaveLength(0);

    const welcome = hello(session, lurker, { role: 'spectator', name: '迟到观战' });
    expect(lurker.sent.filter((message) => message.type === 'game.state')).toHaveLength(0);
    expect(welcome.payload.game.stepNumber).toBe(session.getMatch()!.stepNumber);
    expectHiddenPiecesAreOpaque(welcome.payload.game.gameState);
  });

  it('被替换的旧连接不再收到广播，新连接收到当前公开快照', () => {
    const { session, host, matchId } = startMatch();
    const replacement = new FakeConnection();
    session.attach(replacement);
    hello(session, replacement, { role: 'host', name: '房主', token: session.hostToken });

    const staleCount = host.sent.length;
    flip(session, replacement, matchId, 'req-replace');
    expect(host.sent.slice(staleCount).filter((message) => message.type === 'game.patch')).toHaveLength(0);
    expect(replacement.last('game.patch')).not.toBeNull();
  });

  it('两个独立会话互不串流：一个会话的动作只出现在自己的连接上', () => {
    const a = startMatch();
    const b = startMatch();
    expect(a.session.roomId).not.toBe(b.session.roomId);

    const beforeOther = b.host.sent.length;
    flip(a.session, a.host, a.matchId, 'req-isolated');
    expect(a.host.last('game.patch')!.payload.stepNumber).toBe(1);
    expect(b.host.sent.slice(beforeOther)).toHaveLength(0);
  });

  it('翻牌只公开该枚棋子；悔棋重新盖回后公开视图不再暴露其身份', () => {
    const { session, host, guest, matchId } = startMatch();
    const before = session.getPublicMatch()!.gameState;
    flip(session, host, matchId, 'req-flip');
    const after = session.getPublicMatch()!.gameState;

    const revealedBefore = before.pieces.filter((piece) => piece.revealed).length;
    const revealedAfter = after.pieces.filter((piece) => piece.revealed).length;
    expect(revealedAfter).toBe(revealedBefore + 1);

    // 真实悔棋协商：请求 → 同意 → 重新盖回
    const match = session.getMatch()!;
    deliver(
      session,
      host,
      buildClientGameNegotiate(session.roomId, {
        requestId: 'neg-1',
        matchId,
        revision: match.revision,
        kind: 'undo',
      }),
    );
    const pending = session.getPublicMatch()!.pendingNegotiation!;
    deliver(
      session,
      guest,
      buildClientGameNegotiateReply(session.roomId, {
        requestId: 'neg-reply-1',
        matchId,
        negotiationId: pending.negotiationId,
        accept: true,
      }),
    );
    const undone = session.getPublicMatch()!.gameState;
    expect(undone.pieces.filter((piece) => piece.revealed).length).toBe(revealedBefore);
    expect(undone.actionHistory).toHaveLength(0);
    expectHiddenPiecesAreOpaque(undone);
  });

  it('落点提示只给当前行棋方明子，并区分 empty / capture，不含暗子身份', () => {
    const match = makeMatch(7);
    const projected = projectGameState(match);
    const pieceByPublicId = new Map(projected.pieces.map((piece) => [piece.id, piece]));

    expect(projected.legalMoves.length).toBeGreaterThan(0);
    for (const group of projected.legalMoves) {
      const piece = pieceByPublicId.get(group.pieceId)!;
      expect(piece).toBeTruthy();
      expect(piece.revealed).toBe(true);
      if (piece.revealed) {
        expect(piece.camp).toBe(match.gameState.currentTurn);
      }
      expect(piece.position).toEqual(group.from);
      for (const target of group.targets) {
        expect(['empty', 'capture']).toContain(target.kind);
      }
    }

    // 终局不提供落点提示
    const ended = { ...match, gameState: { ...match.gameState, winner: 'red' as const } };
    expect(projectGameState(ended).legalMoves).toHaveLength(0);
  });

  it('身份置换与内部数组打乱不改变序列化结果', () => {
    const match = makeMatch(11);
    const now = match.clock.getSnapshot().serverTime;
    const baseJson = JSON.stringify(projectMatchSnapshot(match, now).gameState);

    // 1) 打乱内部棋子数组顺序：公开数组顺序只由公开坐标决定。
    const shuffled = {
      ...match,
      gameState: { ...match.gameState, pieces: [...match.gameState.pieces].reverse() },
    };
    expect(JSON.stringify(projectMatchSnapshot(shuffled, now).gameState)).toBe(baseJson);

    // 2) 在两个未翻棋子之间交换阵营/棋种：公开投影不包含这些字段，结果必须完全一致。
    const hidden = match.gameState.pieces.filter((piece) => !piece.revealed);
    expect(hidden.length).toBeGreaterThan(1);
    const [first, second] = hidden;
    const swapped = {
      ...match,
      gameState: {
        ...match.gameState,
        pieces: match.gameState.pieces.map((piece) => {
          if (piece.id === first.id) {
            return { ...piece, camp: second.camp, type: second.type };
          }
          if (piece.id === second.id) {
            return { ...piece, camp: first.camp, type: first.type };
          }
          return piece;
        }),
      },
    };
    expect(JSON.stringify(projectMatchSnapshot(swapped, now).gameState)).toBe(baseJson);
  });

  it('投影是只读的：多次投影不改变内部棋子、历史或开局', () => {
    const match = makeMatch(13);
    const snapshot = JSON.stringify(match);
    projectMatchSnapshot(match);
    projectMatchSnapshot(match);
    expect(JSON.stringify(match)).toBe(snapshot);
  });

  it('多局之间的公开 ID 不重复且与本局布局种子无关', () => {
    const idsA = projectGameState(makeMatch(21)).pieces.map((piece) => piece.id);
    const idsB = projectGameState(makeMatch(21)).pieces.map((piece) => piece.id);
    expect(new Set(idsA).size).toBe(idsA.length);
    expect(idsA).toEqual(idsB); // 同一固定 token 源：映射按初始格位顺序稳定
  });

  it('真实随机 token 源下公开 ID 稳定、唯一且不编码身份', () => {
    const match = makeMatch(31);
    const first = projectGameState(match).pieces.map((piece) => piece.id);
    const second = projectGameState(match).pieces.map((piece) => piece.id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    for (const id of first) {
      expect(id).not.toMatch(/(red|black|king|rook|cannon|horse|elephant|advisor|pawn)/);
    }
  });

  it('悔棋后同一公开 ID 仍指向同一枚棋子', () => {
    const match = makeMatch(41);
    const before = projectGameState(match);
    const hidden = match.gameState.pieces.find((piece) => !piece.revealed)!;
    const publicId = match.publicPieceIds[hidden.id];
    const projectedHidden = before.pieces.find((piece) => piece.id === publicId)!;
    expect(projectedHidden.position).toEqual(hidden.position);
    expect(projectedHidden.revealed).toBe(false);
  });

  it('向暗格移动的拒绝文案不随暗子阵营变化', () => {
    const own: Piece[] = [
      { id: 'a', camp: 'red', type: 'rook', position: { x: 0, y: 0 }, revealed: true, captured: false },
      { id: 'b', camp: 'red', type: 'pawn', position: { x: 0, y: 1 }, revealed: false, captured: false },
    ];
    const enemy: Piece[] = [own[0], { ...own[1], camp: 'black' }];
    const ownResult = validateMove({ pieces: own, currentTurn: 'red' }, own[0], { x: 0, y: 1 });
    const enemyResult = validateMove({ pieces: enemy, currentTurn: 'red' }, enemy[0], { x: 0, y: 1 });
    expect(ownResult.ok).toBe(false);
    expect(enemyResult.ok).toBe(false);
    expect(ownResult.reason).toBe(enemyResult.reason);

    // 已翻开的己方棋子仍然返回「不能吃己方棋子」。
    const revealedOwn: Piece[] = [own[0], { ...own[1], revealed: true }];
    expect(validateMove({ pieces: revealedOwn, currentTurn: 'red' }, revealedOwn[0], { x: 0, y: 1 }).reason)
      .toBe('不能吃己方棋子');
  });
});

describe('公开投影撤销语义', () => {
  it('撤销后历史被裁剪，公开视图不保留被盖回棋子的身份', () => {
    const match = makeMatch(51);
    const hidden = match.gameState.pieces.find((piece) => !piece.revealed && piece.position)!;
    const accepted = applyMatchAction(match, START_PARAMETERS.redMemberId, {
      type: 'flip',
      position: hidden.position!,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      return;
    }
    const projected = projectGameState(accepted.match);
    const publicId = accepted.match.publicPieceIds[hidden.id];
    expect(projected.pieces.find((piece) => piece.id === publicId)).toMatchObject({ revealed: true });

    const undone = undoMatchAction(accepted.match);
    expect(undone.ok).toBe(true);
    if (!undone.ok) {
      return;
    }
    const reverted = projectGameState(undone.match);
    const revertedPiece = reverted.pieces.find((piece) => piece.id === publicId)!;
    expect(revertedPiece.revealed).toBe(false);
    expect(Object.keys(revertedPiece).sort()).toEqual(['id', 'position', 'revealed']);
  });
});
