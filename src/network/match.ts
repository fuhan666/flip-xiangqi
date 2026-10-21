/**
 * 权威对局模型与动作仲裁：
 * - 共享确定性种子随机源（uint32 LCG）；
 * - 权威开局初始化、步数递增、行棋方校验与规则校验；
 * - 可传输的对局快照（去除 undoStack），并独立携带开局帧 initial。
 */
import { applyAction, cloneStateSnapshot, createInitialGameState, snapshotState, undoLastAction } from '../game/index.js';
import type { GameAction, GameHistoryEntry, GameState, GameStateSnapshot, Piece, PieceType, Position } from '../game/index.js';
import { parseStartParameters, type StartParameters } from './lobby.js';
import {
  MatchClock,
  parseMatchClockSnapshot,
  parseMatchSettlement,
  type EndgameReason,
  type MatchClockSnapshot,
  type MatchSettlement,
} from './match-clock.js';
import {
  parseDrawCooldownUntil,
  parseNegotiationEvent,
  parsePendingNegotiation,
  type NegotiationEvent,
  type PendingNegotiation,
} from './negotiation.js';
import { parsePhraseCooldownUntil } from './quick-chat.js';

export {
  parseMatchClockSnapshot,
  parseMatchSettlement,
  type EndgameReason,
  type MatchClockSnapshot,
  type MatchSettlement,
} from './match-clock.js';

export {
  parseDrawCooldownUntil,
  parseNegotiationEvent,
  parsePendingNegotiation,
  type NegotiationEvent,
  type PendingNegotiation,
} from './negotiation.js';

export interface MatchEvent {
  id: string;
  type: string;
  actorMemberId: string;
  stepNumber: number;
  revision: number;
  result: string;
  createdAt: number;
  message?: string;
}

export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export type MatchAction =
  | { type: 'flip'; position: Position }
  | { type: 'move'; from: Position; to: Position };

export interface MatchState {
  matchId: string;
  seed: number;
  stepNumber: number;
  revision: number;
  startParameters: StartParameters;
  /** 独立保存的开局帧（空历史、无撤销），棋局推进与撤销都不改变它。 */
  initial: GameStateSnapshot;
  gameState: GameState;
  /**
   * 内部棋子 ID → 本局不透明公开 ID 的映射（仅服务端持有，永不进入线协议）。
   * 由与本局布局种子无关的安全随机源在开局时按初始格位顺序分配。
   */
  publicPieceIds: Record<string, string>;
  clock: MatchClock;
  settlement: MatchSettlement | null;
  pendingNegotiation: PendingNegotiation | null;
  drawCooldownUntil: Record<string, number>;
  phraseCooldownUntil: Record<string, number>;
  negotiationEvent: NegotiationEvent | null;
  matchEvents: MatchEvent[];
}

export interface MatchSnapshot {
  matchId: string;
  seed: number;
  stepNumber: number;
  revision: number;
  startParameters: StartParameters;
  initial: GameStateSnapshot;
  gameState: GameStateSnapshot;
  clock: MatchClockSnapshot;
  settlement: MatchSettlement | null;
  pendingNegotiation: PendingNegotiation | null;
  drawCooldownUntil: Record<string, number>;
  phraseCooldownUntil?: Record<string, number>;
  negotiationEvent: NegotiationEvent | null;
  matchEvents?: MatchEvent[];
}

export function isValidCoordinate(x: unknown, y: unknown): x is number {
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x <= 8 &&
    y >= 0 &&
    y <= 9
  );
}

export function parsePosition(value: unknown): Position | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { x, y } = value as Record<string, unknown>;
  if (!isValidCoordinate(x, y)) {
    return null;
  }
  return { x, y: y as number };
}

export function parseMatchAction(value: unknown): MatchAction | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const rawType = typeof candidate.type === 'string' ? candidate.type.toLowerCase() : null;

  if (rawType === 'flip') {
    const position = parsePosition(candidate.position);
    if (!position) {
      return null;
    }
    return { type: 'flip', position };
  }

  if (rawType === 'move') {
    const from = parsePosition(candidate.from);
    const to = parsePosition(candidate.to);
    if (!from || !to) {
      return null;
    }
    return { type: 'move', from, to };
  }

  return null;
}

const VALID_PIECE_TYPES = new Set(['king', 'advisor', 'elephant', 'horse', 'rook', 'cannon', 'pawn']);

export function parsePiece(value: unknown): Piece | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    raw.id.length === 0 ||
    (raw.camp !== 'red' && raw.camp !== 'black') ||
    typeof raw.type !== 'string' ||
    !VALID_PIECE_TYPES.has(raw.type) ||
    typeof raw.revealed !== 'boolean' ||
    typeof raw.captured !== 'boolean'
  ) {
    return null;
  }

  if (raw.captured) {
    if (raw.position !== null) {
      return null;
    }
    return {
      id: raw.id,
      camp: raw.camp,
      type: raw.type as PieceType,
      position: null,
      revealed: raw.revealed,
      captured: true,
    };
  }

  const pos = parsePosition(raw.position);
  if (!pos) {
    return null;
  }
  return {
    id: raw.id,
    camp: raw.camp,
    type: raw.type as PieceType,
    position: pos,
    revealed: raw.revealed,
    captured: false,
  };
}

export function parseGameStateSnapshot(value: unknown): GameStateSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.pieces) ||
    (raw.currentTurn !== 'red' && raw.currentTurn !== 'black') ||
    (raw.winner !== null && raw.winner !== 'red' && raw.winner !== 'black') ||
    (raw.checkedCamp !== null && raw.checkedCamp !== 'red' && raw.checkedCamp !== 'black') ||
    (raw.lastError !== null && typeof raw.lastError !== 'string') ||
    typeof raw.statusMessage !== 'string' ||
    !Array.isArray(raw.actionHistory)
  ) {
    return null;
  }

  const pieces: Piece[] = [];
  const occupiedCoords = new Set<string>();
  for (const item of raw.pieces) {
    const piece = parsePiece(item);
    if (!piece) {
      return null;
    }
    if (!piece.captured && piece.position) {
      const coordKey = `${piece.position.x},${piece.position.y}`;
      if (occupiedCoords.has(coordKey)) {
        return null;
      }
      occupiedCoords.add(coordKey);
    }
    pieces.push(piece);
  }

  const actionHistory: GameHistoryEntry[] = [];
  for (const item of raw.actionHistory) {
    const parsed = parseHistoryEntry(item);
    if (!parsed) {
      return null;
    }
    actionHistory.push(parsed);
  }

  let recentAction: GameHistoryEntry | null = null;
  if (raw.recentAction) {
    recentAction = parseHistoryEntry(raw.recentAction);
    if (!recentAction) {
      return null;
    }
  }

  return {
    pieces,
    currentTurn: raw.currentTurn,
    winner: raw.winner,
    checkedCamp: raw.checkedCamp,
    lastError: raw.lastError ?? null,
    statusMessage: raw.statusMessage,
    actionHistory,
    recentAction,
  };
}

/**
 * 开局帧：合法快照且仅含开局内容（空历史、无最近动作、未分胜负）。
 * initial 必填且只接受开局帧，不提供从 seed/undo/当前盘面重建的路径。
 */
export function parseOpeningSnapshot(value: unknown): GameStateSnapshot | null {
  const snapshot = parseGameStateSnapshot(value);
  if (!snapshot) {
    return null;
  }
  if (snapshot.actionHistory.length !== 0 || snapshot.recentAction !== null || snapshot.winner !== null) {
    return null;
  }
  return snapshot;
}

export function parseHistoryEntry(item: unknown): GameHistoryEntry | null {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const entry = item as Record<string, unknown>;
  const stepNumber =
    typeof entry.stepNumber === 'number'
      ? entry.stepNumber
      : typeof entry.turnNumber === 'number'
        ? entry.turnNumber
        : null;
  if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber) || stepNumber < 1) {
    return null;
  }
  const turnNumber =
    typeof entry.turnNumber === 'number' && Number.isInteger(entry.turnNumber) && entry.turnNumber >= 1
      ? entry.turnNumber
      : stepNumber;

  if (
    (entry.actor !== 'red' && entry.actor !== 'black') ||
    !entry.action ||
    typeof entry.action !== 'object' ||
    !Array.isArray(entry.consequences) ||
    (entry.nextTurn !== null && entry.nextTurn !== 'red' && entry.nextTurn !== 'black') ||
    (entry.checkedCamp !== null && entry.checkedCamp !== 'red' && entry.checkedCamp !== 'black') ||
    (entry.winner !== null && entry.winner !== 'red' && entry.winner !== 'black') ||
    typeof entry.statusMessage !== 'string'
  ) {
    return null;
  }

  if (
    entry.durationSeconds !== undefined &&
    entry.durationSeconds !== null &&
    (typeof entry.durationSeconds !== 'number' || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds < 0)
  ) {
    return null;
  }

  if (
    entry.kind !== undefined &&
    entry.kind !== 'flip' &&
    entry.kind !== 'move' &&
    entry.kind !== 'capture'
  ) {
    return null;
  }

  const action = entry.action as Record<string, unknown>;
  if (action.type === 'flip') {
    const pos = parsePosition(action.position);
    if (!pos) {
      return null;
    }
    if (action.from && !parsePosition(action.from)) {
      return null;
    }
    if (action.to && !parsePosition(action.to)) {
      return null;
    }
  } else if (action.type === 'move') {
    if (!parsePosition(action.from) || !parsePosition(action.to)) {
      return null;
    }
  } else {
    return null;
  }

  const kind =
    (entry.kind as GameHistoryEntry['kind']) ??
    (action.type === 'flip'
      ? 'flip'
      : (entry.consequences as Array<{ type: string }>).some((c) => c.type === 'capture')
        ? 'capture'
        : 'move');

  return {
    ...(entry as unknown as GameHistoryEntry),
    stepNumber,
    turnNumber,
    kind,
    durationSeconds: (entry.durationSeconds as number | null) ?? null,
  };
}

export function parseMatchEvents(value: unknown): MatchEvent[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const events: MatchEvent[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.id !== 'string' ||
      !raw.id ||
      typeof raw.type !== 'string' ||
      !raw.type ||
      typeof raw.actorMemberId !== 'string' ||
      typeof raw.stepNumber !== 'number' ||
      typeof raw.revision !== 'number' ||
      typeof raw.result !== 'string' ||
      typeof raw.createdAt !== 'number'
    ) {
      return null;
    }
    events.push({
      id: raw.id,
      type: raw.type,
      actorMemberId: raw.actorMemberId,
      stepNumber: raw.stepNumber,
      revision: raw.revision,
      result: raw.result,
      createdAt: raw.createdAt,
      ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    });
  }
  return events;
}

export function parseMatchSnapshot(value: unknown): MatchSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.matchId !== 'string' ||
    raw.matchId.length === 0 ||
    typeof raw.seed !== 'number' ||
    !Number.isInteger(raw.seed) ||
    raw.seed < 0 ||
    raw.seed > 0xffffffff ||
    typeof raw.stepNumber !== 'number' ||
    !Number.isSafeInteger(raw.stepNumber) ||
    raw.stepNumber < 0
  ) {
    return null;
  }

  const revision =
    typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0;

  const startParameters = parseStartParameters(raw.startParameters);
  if (!startParameters) {
    return null;
  }

  const gameState = parseGameStateSnapshot(raw.gameState);
  if (!gameState) {
    return null;
  }

  const initial = parseOpeningSnapshot(raw.initial);
  if (!initial) {
    return null;
  }

  let clock: MatchClockSnapshot | null = null;
  if (raw.clock) {
    clock = parseMatchClockSnapshot(raw.clock);
    if (!clock) {
      return null;
    }
  } else {
    // 兼容可能省略 clock 的测试数据
    const hostSeat = startParameters.players.find((p) => p.role === 'host');
    const dummyClock = new MatchClock({
      baseTimeSeconds: startParameters.baseTimeSeconds,
      incrementSeconds: startParameters.incrementSeconds,
      hostSide: hostSeat?.side ?? 'red',
    });
    clock = dummyClock.getSnapshot();
  }

  const settlement = raw.settlement ? parseMatchSettlement(raw.settlement) : null;
  const pendingNegotiation = raw.pendingNegotiation ? parsePendingNegotiation(raw.pendingNegotiation) : null;
  const drawCooldownUntil = raw.drawCooldownUntil ? parseDrawCooldownUntil(raw.drawCooldownUntil) ?? {} : {};
  const phraseCooldownUntil = raw.phraseCooldownUntil ? parsePhraseCooldownUntil(raw.phraseCooldownUntil) ?? {} : {};
  const negotiationEvent = raw.negotiationEvent ? parseNegotiationEvent(raw.negotiationEvent) : null;
  const matchEvents = Array.isArray(raw.matchEvents) ? parseMatchEvents(raw.matchEvents) ?? [] : [];

  return {
    matchId: raw.matchId,
    seed: raw.seed,
    stepNumber: raw.stepNumber,
    revision,
    startParameters,
    initial,
    gameState,
    clock,
    settlement,
    pendingNegotiation,
    drawCooldownUntil,
    phraseCooldownUntil,
    negotiationEvent,
    matchEvents,
  };
}

export function createMatch(input: {
  matchId: string;
  seed: number;
  startParameters: StartParameters;
  nowFn?: () => number;
  initialTime?: number;
  /** 公开棋子 ID 生成器：按初始格位顺序调用，与布局随机源相互独立。 */
  publicIdFactory?: (index: number) => string;
}): MatchState {
  const rng = createSeededRng(input.seed);
  const gameState = createInitialGameState(rng);
  const hostSeat = input.startParameters.players.find((seat) => seat.role === 'host');
  const clock = new MatchClock({
    baseTimeSeconds: input.startParameters.baseTimeSeconds,
    incrementSeconds: input.startParameters.incrementSeconds,
    hostSide: hostSeat?.side ?? 'red',
    nowFn: input.nowFn,
    initialTime: input.initialTime,
  });

  return {
    matchId: input.matchId,
    seed: input.seed,
    stepNumber: 0,
    revision: 0,
    startParameters: input.startParameters,
    initial: snapshotState(gameState),
    gameState,
    publicPieceIds: assignPublicPieceIds(gameState.pieces, input.publicIdFactory ?? createRandomPublicIdFactory()),
    clock,
    settlement: null,
    pendingNegotiation: null,
    drawCooldownUntil: {},
    phraseCooldownUntil: {},
    negotiationEvent: null,
    matchEvents: [],
  };
}

function createRandomPublicIdFactory(): (index: number) => string {
  return (index) => `p${index.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 按初始格位的规范顺序（先 y 后 x）为每枚棋子分配本局公开 ID。
 * 顺序与布局随机源无关，公开 ID 也不编码阵营/棋种。
 */
function assignPublicPieceIds(
  pieces: readonly Piece[],
  factory: (index: number) => string,
): Record<string, string> {
  const ordered = [...pieces].sort((left, right) => {
    const leftY = left.position?.y ?? Number.MAX_SAFE_INTEGER;
    const rightY = right.position?.y ?? Number.MAX_SAFE_INTEGER;
    if (leftY !== rightY) {
      return leftY - rightY;
    }
    return (left.position?.x ?? Number.MAX_SAFE_INTEGER) - (right.position?.x ?? Number.MAX_SAFE_INTEGER);
  });

  const ids: Record<string, string> = {};
  const used = new Set<string>();
  ordered.forEach((piece, index) => {
    const publicId = factory(index);
    if (!publicId || used.has(publicId)) {
      throw new Error('public piece id factory produced an empty or duplicate id');
    }
    used.add(publicId);
    ids[piece.id] = publicId;
  });
  return ids;
}

export function snapshotMatch(match: MatchState, now?: number): MatchSnapshot {
  return {
    matchId: match.matchId,
    seed: match.seed,
    stepNumber: match.stepNumber,
    revision: match.revision,
    startParameters: match.startParameters,
    initial: cloneStateSnapshot(match.initial),
    gameState: snapshotState(match.gameState),
    clock: match.clock.getSnapshot(now),
    settlement: match.settlement ?? match.clock.getSettlement(),
    pendingNegotiation: match.pendingNegotiation,
    drawCooldownUntil: { ...match.drawCooldownUntil },
    phraseCooldownUntil: { ...match.phraseCooldownUntil },
    negotiationEvent: match.negotiationEvent,
    matchEvents: match.matchEvents.map((e) => ({ ...e })),
  };
}

export type MatchActionResult =
  | { ok: true; match: MatchState; resultingAction: GameHistoryEntry }
  | { ok: false; reason: string };

export function applyMatchAction(
  match: MatchState,
  actorMemberId: string,
  action: GameAction,
  now?: number,
): MatchActionResult {
  if (match.settlement !== null || match.gameState.winner !== null) {
    return { ok: false, reason: '对局已经结束，请重新开局' };
  }

  if (match.pendingNegotiation !== null) {
    return { ok: false, reason: '协商正在进行中，棋盘操作已锁定' };
  }

  // 1. 先进行时钟结算与超时判定
  const advanceResult = match.clock.advance(now);
  if (advanceResult.timeoutResult) {
    match.settlement = advanceResult.timeoutResult;
    match.gameState.winner = advanceResult.timeoutResult.winner;
    match.revision++;
    return { ok: false, reason: '对局已超时结束' };
  }

  if (match.clock.isPaused) {
    return { ok: false, reason: '对手已离线，暂无法操作' };
  }

  const currentTurn = match.gameState.currentTurn;
  const expectedMemberId =
    currentTurn === 'red' ? match.startParameters.redMemberId : match.startParameters.blackMemberId;

  if (actorMemberId !== expectedMemberId) {
    return { ok: false, reason: '非己方回合，请等待对方行动' };
  }

  const stepDurationSeconds = match.clock.getCurrentStepDurationSeconds();
  const nextGameState = applyAction(match.gameState, action, { durationSeconds: stepDurationSeconds });
  if (nextGameState.lastError) {
    return { ok: false, reason: nextGameState.lastError };
  }

  // 成功动作在 advance 扣除该步思考时间后、切换回合前，保存服务端专用时钟检查点
  match.clock.saveCheckpoint();

  // 行动成功推进时钟
  match.clock.onAction(now);

  let settlement: MatchSettlement | null = match.settlement;
  if (nextGameState.winner !== null) {
    const isKingCapture = nextGameState.recentAction?.consequences.some(
      (c) => c.type === 'endgame' && c.reason === 'king-captured',
    );
    const reason: EndgameReason = isKingCapture ? 'king-captured' : 'checkmate';
    settlement = match.clock.finalize(nextGameState.winner, reason, now);
  }

  const nextMatch: MatchState = {
    ...match,
    stepNumber: match.stepNumber + 1,
    revision: match.revision + 1,
    gameState: nextGameState,
    settlement,
  };

  return {
    ok: true,
    match: nextMatch,
    resultingAction: nextGameState.recentAction!,
  };
}

export function finalizeMatch(
  match: MatchState,
  winner: 'red' | 'black' | null,
  reason: EndgameReason,
  now?: number,
): MatchState {
  if (winner === null) {
    return finalizeMatchDraw(match, reason, now);
  }
  const settlement = match.clock.finalize(winner, reason, now);
  match.gameState.winner = winner;
  return {
    ...match,
    revision: match.revision + 1,
    settlement,
  };
}

export function finalizeMatchDraw(
  match: MatchState,
  reason: EndgameReason = 'draw-agreement',
  now?: number,
): MatchState {
  const settlement = match.clock.finalizeDraw(reason, now);
  match.gameState.statusMessage = '双方握手言和，平局';
  return {
    ...match,
    revision: match.revision + 1,
    settlement,
  };
}

export function undoMatchAction(
  match: MatchState,
  now?: number,
): { ok: true; match: MatchState } | { ok: false; reason: string } {
  if (match.gameState.actionHistory.length === 0) {
    return { ok: false, reason: '开局暂无走子记录，无法悔棋' };
  }
  const nextGameState = undoLastAction(match.gameState);
  match.clock.undoLastAction(now);
  return {
    ok: true,
    match: {
      ...match,
      stepNumber: Math.max(0, match.stepNumber - 1),
      revision: match.revision + 1,
      gameState: nextGameState,
      settlement: null,
    },
  };
}
