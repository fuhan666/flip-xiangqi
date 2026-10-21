/**
 * 公开棋局增量补丁：常规走棋只下发差异，客户端原子应用。
 *
 * 与 `public-game.ts` 的分工：
 * - 该文件定义补丁的公开线格式、严格校验、服务端求差与客户端应用；
 * - 补丁只承载公开字段，绝不携带 seed / 开局帧 / 撤销栈 / 暗子身份；
 * - 省略字段表示「不变」，`null` 表示「显式清空」；
 * - 棋子只下发被替换的完整单枚公开棋子，按稳定不透明 ID 寻址；
 * - 历史与对局事件用 `{ baseLength, keep, append }` 保留公共前缀后追加/截尾。
 */
import type { Camp, GameHistoryEntry, LegalMoveGroup, Position } from '../game/index.js';
import {
  parseMatchClockSnapshot,
  parseMatchEvents,
  parseMatchSettlement,
  parseHistoryEntry,
  parseNegotiationEvent,
  parsePendingNegotiation,
} from './match.js';
import type { MatchClockSnapshot, MatchEvent, MatchSettlement } from './match.js';
import { parseDrawCooldownUntil } from './match.js';
import { parsePhraseCooldownUntil } from './quick-chat.js';
import type { NegotiationEvent, PendingNegotiation } from './negotiation.js';
import { parseLegalMoves, parsePublicPiece } from './public-game.js';
import type { PublicGameState, PublicMatchSnapshot, PublicPiece } from './public-game.js';

/** 前缀共享的有序列表差异：先保留 keep 项，再追加 append。 */
export interface PublicListDelta<T> {
  baseLength: number;
  keep: number;
  append: T[];
}

/**
 * 公开棋局差异。字段缺省表示不变；`null` 表示显式清空。
 * 时钟只在状态转换（行动方切换、暂停/恢复、结算）时随补丁下发一次采样；
 * 常规走秒仍由 1Hz 的 game.clock 广播负责，补丁不是计时来源。
 */
export interface PublicGameDelta {
  pieces?: PublicPiece[];
  clock?: MatchClockSnapshot | null;
  currentTurn?: Camp;
  winner?: Camp | null;
  checkedCamp?: Camp | null;
  lastError?: string | null;
  statusMessage?: string;
  recentAction?: GameHistoryEntry | null;
  legalMoves?: LegalMoveGroup[];
  history?: PublicListDelta<GameHistoryEntry>;
  matchEvents?: PublicListDelta<MatchEvent>;
  settlement?: MatchSettlement | null;
  pendingNegotiation?: PendingNegotiation | null;
  drawCooldownUntil?: Record<string, number>;
  phraseCooldownUntil?: Record<string, number>;
  negotiationEvent?: NegotiationEvent | null;
}

export interface PublicGamePatch {
  matchId: string;
  /** 补丁所基于的公开版本：接收方必须正处在该版本。 */
  baseRevision: number;
  /** 应用后的公开版本，必须大于 baseRevision，但不要求恰好 +1。 */
  revision: number;
  /** 应用后的有效步数（actionHistory 长度），可因悔棋下降。 */
  stepNumber: number;
  changes: PublicGameDelta;
}

const DELTA_KEYS = new Set([
  'pieces',
  'clock',
  'currentTurn',
  'winner',
  'checkedCamp',
  'lastError',
  'statusMessage',
  'recentAction',
  'legalMoves',
  'history',
  'matchEvents',
  'settlement',
  'pendingNegotiation',
  'drawCooldownUntil',
  'phraseCooldownUntil',
  'negotiationEvent',
]);

const CAMPS = new Set<string>(['red', 'black']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCamp(value: unknown): Camp | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' && CAMPS.has(value) ? (value as Camp) : undefined;
}

function parseSafeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseListDelta<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): PublicListDelta<T> | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseLength = parseSafeCount(value.baseLength);
  const keep = parseSafeCount(value.keep);
  if (baseLength === null || keep === null || keep > baseLength || !Array.isArray(value.append)) {
    return null;
  }
  const append: T[] = [];
  for (const item of value.append) {
    const parsed = parseItem(item);
    if (parsed === null) {
      return null;
    }
    append.push(parsed);
  }
  return { baseLength, keep, append };
}

/** 严格校验公开差异：未知字段、非法棋子、越界数组一律拒绝。 */
export function parsePublicGameDelta(value: unknown): PublicGameDelta | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!DELTA_KEYS.has(key)) {
      return null;
    }
  }

  const delta: PublicGameDelta = {};

  if (value.pieces !== undefined) {
    if (!Array.isArray(value.pieces)) {
      return null;
    }
    const pieces: PublicPiece[] = [];
    const seen = new Set<string>();
    for (const item of value.pieces) {
      const piece = parsePublicPiece(item);
      if (!piece || seen.has(piece.id)) {
        return null;
      }
      seen.add(piece.id);
      pieces.push(piece);
    }
    delta.pieces = pieces;
  }

  if (value.clock !== undefined) {
    if (value.clock === null) {
      delta.clock = null;
    } else {
      const clock = parseMatchClockSnapshot(value.clock);
      if (!clock) {
        return null;
      }
      delta.clock = clock;
    }
  }

  if (value.currentTurn !== undefined) {
    const camp = parseCamp(value.currentTurn);
    if (!camp) {
      return null;
    }
    delta.currentTurn = camp;
  }
  if (value.winner !== undefined) {
    const camp = parseCamp(value.winner);
    if (camp === undefined) {
      return null;
    }
    delta.winner = camp;
  }
  if (value.checkedCamp !== undefined) {
    const camp = parseCamp(value.checkedCamp);
    if (camp === undefined) {
      return null;
    }
    delta.checkedCamp = camp;
  }
  if (value.lastError !== undefined) {
    if (value.lastError !== null && typeof value.lastError !== 'string') {
      return null;
    }
    delta.lastError = value.lastError;
  }
  if (value.statusMessage !== undefined) {
    if (typeof value.statusMessage !== 'string') {
      return null;
    }
    delta.statusMessage = value.statusMessage;
  }
  if (value.recentAction !== undefined) {
    if (value.recentAction === null) {
      delta.recentAction = null;
    } else {
      const entry = parseHistoryEntry(value.recentAction);
      if (!entry) {
        return null;
      }
      delta.recentAction = entry;
    }
  }
  if (value.legalMoves !== undefined) {
    const legalMoves = parseLegalMoves(value.legalMoves);
    if (!legalMoves) {
      return null;
    }
    delta.legalMoves = legalMoves;
  }
  if (value.history !== undefined) {
    const history = parseListDelta(value.history, parseHistoryEntry);
    if (!history) {
      return null;
    }
    delta.history = history;
  }
  if (value.matchEvents !== undefined) {
    const events = parseListDelta(value.matchEvents, (item) => {
      const parsed = parseMatchEvents([item]);
      return parsed ? parsed[0] : null;
    });
    if (!events) {
      return null;
    }
    delta.matchEvents = events;
  }
  if (value.settlement !== undefined) {
    if (value.settlement === null) {
      delta.settlement = null;
    } else {
      const settlement = parseMatchSettlement(value.settlement);
      if (!settlement) {
        return null;
      }
      delta.settlement = settlement;
    }
  }
  if (value.pendingNegotiation !== undefined) {
    if (value.pendingNegotiation === null) {
      delta.pendingNegotiation = null;
    } else {
      const pending = parsePendingNegotiation(value.pendingNegotiation);
      if (!pending) {
        return null;
      }
      delta.pendingNegotiation = pending;
    }
  }
  if (value.drawCooldownUntil !== undefined) {
    const cooldown = parseDrawCooldownUntil(value.drawCooldownUntil);
    if (!cooldown) {
      return null;
    }
    delta.drawCooldownUntil = cooldown;
  }
  if (value.phraseCooldownUntil !== undefined) {
    const cooldown = parsePhraseCooldownUntil(value.phraseCooldownUntil);
    if (!cooldown) {
      return null;
    }
    delta.phraseCooldownUntil = cooldown;
  }
  if (value.negotiationEvent !== undefined) {
    if (value.negotiationEvent === null) {
      delta.negotiationEvent = null;
    } else {
      const event = parseNegotiationEvent(value.negotiationEvent);
      if (!event) {
        return null;
      }
      delta.negotiationEvent = event;
    }
  }

  return delta;
}

export function parsePublicGamePatch(value: unknown): PublicGamePatch | null {
  if (!isRecord(value)) {
    return null;
  }
  const { matchId } = value;
  if (typeof matchId !== 'string' || matchId.length === 0) {
    return null;
  }
  const baseRevision = parseSafeCount(value.baseRevision);
  const revision = parseSafeCount(value.revision);
  const stepNumber = parseSafeCount(value.stepNumber);
  if (baseRevision === null || revision === null || stepNumber === null || revision <= baseRevision) {
    return null;
  }
  const changes = parsePublicGameDelta(value.changes);
  if (!changes) {
    return null;
  }
  return { matchId, baseRevision, revision, stepNumber, changes };
}

function positionOrder(piece: { position: Position | null }): [number, number] {
  if (!piece.position) {
    return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  }
  return [piece.position.y, piece.position.x];
}

/** 与公开投影一致的可下发展示顺序：先按坐标，再按公开 ID。 */
export function comparePublicPieces(left: PublicPiece, right: PublicPiece): number {
  const [leftY, leftX] = positionOrder(left);
  const [rightY, rightX] = positionOrder(right);
  if (leftY !== rightY) {
    return leftY - rightY;
  }
  if (leftX !== rightX) {
    return leftX - rightX;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export type ApplyPatchResult =
  | { ok: true; gameState: PublicGameState; matchEvents: MatchEvent[]; clock: MatchClockSnapshot | null | undefined }
  | { ok: false; reason: string };

/**
 * 原子应用公开差异：任何一步校验失败都返回失败且不产生半份状态。
 * 调用方负责先确认 `baseRevision === 本地 revision`，这里只校验补丁自身与本地形状。
 * `clock === undefined` 表示补丁不涉及时钟。
 */
export function applyPublicGameDelta(
  view: PublicGameState,
  matchEvents: MatchEvent[],
  delta: PublicGameDelta,
): ApplyPatchResult {
  let pieces = view.pieces;
  if (delta.pieces) {
    const known = new Set(pieces.map((piece) => piece.id));
    const next = pieces.slice();
    for (const replacement of delta.pieces) {
      if (!known.has(replacement.id)) {
        return { ok: false, reason: 'unknown-piece-id' };
      }
      next[next.findIndex((piece) => piece.id === replacement.id)] = replacement;
    }
    next.sort(comparePublicPieces);
    const occupied = new Set<string>();
    for (const piece of next) {
      if (piece.revealed && piece.captured) {
        continue;
      }
      if (!piece.position) {
        return { ok: false, reason: 'missing-position' };
      }
      const key = `${piece.position.x},${piece.position.y}`;
      if (occupied.has(key)) {
        return { ok: false, reason: 'overlapping-pieces' };
      }
      occupied.add(key);
    }
    pieces = next;
  }

  let actionHistory = view.actionHistory;
  if (delta.history) {
    const { baseLength, keep, append } = delta.history;
    if (actionHistory.length !== baseLength) {
      return { ok: false, reason: 'history-length-mismatch' };
    }
    actionHistory = [...actionHistory.slice(0, keep), ...append];
  }

  let events = matchEvents;
  if (delta.matchEvents) {
    const { baseLength, keep, append } = delta.matchEvents;
    if (events.length !== baseLength) {
      return { ok: false, reason: 'match-events-length-mismatch' };
    }
    events = [...events.slice(0, keep), ...append];
  }

  return {
    ok: true,
    clock: delta.clock,
    gameState: {
      pieces,
      currentTurn: delta.currentTurn ?? view.currentTurn,
      winner: delta.winner !== undefined ? delta.winner : view.winner,
      checkedCamp: delta.checkedCamp !== undefined ? delta.checkedCamp : view.checkedCamp,
      lastError: delta.lastError !== undefined ? delta.lastError : view.lastError,
      statusMessage: delta.statusMessage ?? view.statusMessage,
      actionHistory,
      recentAction: delta.recentAction !== undefined ? delta.recentAction : view.recentAction,
      legalMoves: delta.legalMoves ?? view.legalMoves,
    },
    matchEvents: events,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffList<T>(previous: T[], next: T[]): PublicListDelta<T> {
  let keep = 0;
  while (keep < previous.length && keep < next.length && sameJson(previous[keep], next[keep])) {
    keep += 1;
  }
  return { baseLength: previous.length, keep, append: next.slice(keep) };
}

function diffPieces(previous: PublicPiece[], next: PublicPiece[]): PublicPiece[] | null {
  const previousById = new Map(previous.map((piece) => [piece.id, piece]));
  const sameSet = previous.length === next.length && next.every((piece) => previousById.has(piece.id));
  const changed = next.filter((piece) => !sameJson(previousById.get(piece.id), piece));
  if (changed.length === 0) {
    return null;
  }
  // 棋子集合发生变化时不猜测缺失项：整组替换仍然只是棋盘点位，不是整份快照。
  return sameSet ? changed : next;
}

/**
 * 由前后两份公开快照求差。时钟与开局参数不参与（时钟独立采样，开局参数随局冻结）。
 * 无差异时返回空对象，调用方仍可用它推进版本。
 */
export function diffPublicSnapshot(previous: PublicMatchSnapshot, next: PublicMatchSnapshot): PublicGameDelta {
  const delta: PublicGameDelta = {};

  const pieces = diffPieces(previous.gameState.pieces, next.gameState.pieces);
  if (pieces) {
    delta.pieces = pieces;
  }

  // 只在时钟状态转换时附带一次权威采样；同一采样序号的走秒差值交给 1Hz 广播。
  if ((previous.clock?.sampleSeq ?? null) !== (next.clock?.sampleSeq ?? null)) {
    delta.clock = next.clock;
  }

  const prev = previous.gameState;
  const curr = next.gameState;
  if (prev.currentTurn !== curr.currentTurn) delta.currentTurn = curr.currentTurn;
  if (prev.winner !== curr.winner) delta.winner = curr.winner;
  if (prev.checkedCamp !== curr.checkedCamp) delta.checkedCamp = curr.checkedCamp;
  if (prev.lastError !== curr.lastError) delta.lastError = curr.lastError;
  if (prev.statusMessage !== curr.statusMessage) delta.statusMessage = curr.statusMessage;
  if (!sameJson(prev.recentAction, curr.recentAction)) delta.recentAction = curr.recentAction;
  if (!sameJson(prev.legalMoves, curr.legalMoves)) delta.legalMoves = curr.legalMoves;

  if (!sameJson(prev.actionHistory, curr.actionHistory)) {
    delta.history = diffList(prev.actionHistory, curr.actionHistory);
  }
  if (!sameJson(previous.matchEvents, next.matchEvents)) {
    delta.matchEvents = diffList(previous.matchEvents, next.matchEvents);
  }
  if (!sameJson(previous.settlement, next.settlement)) delta.settlement = next.settlement;
  if (!sameJson(previous.pendingNegotiation, next.pendingNegotiation)) {
    delta.pendingNegotiation = next.pendingNegotiation;
  }
  if (!sameJson(previous.drawCooldownUntil, next.drawCooldownUntil)) {
    delta.drawCooldownUntil = { ...next.drawCooldownUntil };
  }
  if (!sameJson(previous.phraseCooldownUntil, next.phraseCooldownUntil)) {
    delta.phraseCooldownUntil = { ...next.phraseCooldownUntil };
  }
  if (!sameJson(previous.negotiationEvent, next.negotiationEvent)) {
    delta.negotiationEvent = next.negotiationEvent;
  }

  return delta;
}
