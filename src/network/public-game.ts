/**
 * 公开棋局协议：客户端可见的唯一棋局形状与其线格式校验。
 *
 * 该文件必须保持纯 TypeScript（不依赖 Node API 与 DOM API），
 * 由浏览器客户端、宿主服务与测试共用。
 *
 * 与内部 `GameState` / `MatchSnapshot` 的关键差异：
 * - 没有 seed、完整开局帧、撤销栈、时钟检查点或 ID 对照表；
 * - 未翻开的棋子只暴露位置与本局不透明标识，不携带阵营/棋种/吃子状态；
 * - 历史与最近动作沿用既有语义字段，但其中的棋子 ID 已映射为公开标识；
 * - 落点提示由服务端计算并下发，客户端不自行调用规则推导。
 */
import type {
  Camp,
  GameHistoryEntry,
  LegalMoveGroup,
  PieceType,
  Position,
  LegalMoveTargetKind,
} from '../game/index.js';
import {
  parseDrawCooldownUntil,
  parseMatchClockSnapshot,
  parseMatchEvents,
  parseMatchSettlement,
  parseNegotiationEvent,
  parsePendingNegotiation,
  parseHistoryEntry,
} from './match.js';
import { parsePhraseCooldownUntil } from './quick-chat.js';
import { parseStartParameters, type StartParameters } from './lobby.js';
import type {
  MatchAction,
  MatchClockSnapshot,
  MatchEvent,
  MatchSettlement,
} from './match.js';
import type { NegotiationEvent, PendingNegotiation } from './negotiation.js';

/** 未翻开的棋子：只有位置与本局不透明标识。 */
export interface PublicHiddenPiece {
  id: string;
  position: Position;
  revealed: false;
}

/** 已翻开的棋子：身份已经公开，吃子后 position 为 null。 */
export interface PublicRevealedPiece {
  id: string;
  position: Position | null;
  revealed: true;
  camp: Camp;
  type: PieceType;
  captured: boolean;
}

export type PublicPiece = PublicHiddenPiece | PublicRevealedPiece;

export interface PublicGameState {
  pieces: PublicPiece[];
  currentTurn: Camp;
  winner: Camp | null;
  checkedCamp: Camp | null;
  lastError: string | null;
  statusMessage: string;
  actionHistory: GameHistoryEntry[];
  recentAction: GameHistoryEntry | null;
  legalMoves: LegalMoveGroup[];
}

export interface PublicMatchSnapshot {
  matchId: string;
  stepNumber: number;
  revision: number;
  startParameters: StartParameters;
  gameState: PublicGameState;
  clock: MatchClockSnapshot | null;
  settlement: MatchSettlement | null;
  pendingNegotiation: PendingNegotiation | null;
  drawCooldownUntil: Record<string, number>;
  phraseCooldownUntil: Record<string, number>;
  negotiationEvent: NegotiationEvent | null;
  matchEvents: MatchEvent[];
}

/** 无对局时的公开空局面：拒绝、错误等路径用同一种形状回复。 */
export function createEmptyPublicGameState(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    pieces: [],
    currentTurn: 'red',
    winner: null,
    checkedCamp: null,
    lastError: null,
    statusMessage: '',
    actionHistory: [],
    recentAction: null,
    legalMoves: [],
    ...overrides,
  };
}

const VALID_PIECE_TYPES = new Set<string>(['king', 'advisor', 'elephant', 'horse', 'rook', 'cannon', 'pawn']);
const VALID_TARGET_KINDS = new Set<string>(['empty', 'capture']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePosition(value: unknown): Position | null {
  if (!isRecord(value)) {
    return null;
  }
  const { x, y } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)) {
    return null;
  }
  if (x < 0 || x > 8 || y < 0 || y > 9) {
    return null;
  }
  return { x, y };
}

/**
 * 公开棋子校验：暗子绝不能携带 camp/type/captured，
 * 已明子则必须给出完整身份；含未知字段的对象也会被拒绝。
 */
export function parsePublicPiece(value: unknown): PublicPiece | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, revealed } = value;
  if (typeof id !== 'string' || id.length === 0 || typeof revealed !== 'boolean') {
    return null;
  }

  if (!revealed) {
    if ('camp' in value || 'type' in value || 'captured' in value) {
      return null;
    }
    const position = parsePosition(value.position);
    if (!position) {
      return null;
    }
    return { id, position, revealed: false };
  }

  if (value.camp !== 'red' && value.camp !== 'black') {
    return null;
  }
  if (typeof value.type !== 'string' || !VALID_PIECE_TYPES.has(value.type)) {
    return null;
  }
  if (typeof value.captured !== 'boolean') {
    return null;
  }
  if (value.captured) {
    if (value.position !== null) {
      return null;
    }
    return {
      id,
      position: null,
      revealed: true,
      camp: value.camp,
      type: value.type as PieceType,
      captured: true,
    };
  }
  const position = parsePosition(value.position);
  if (!position) {
    return null;
  }
  return {
    id,
    position,
    revealed: true,
    camp: value.camp,
    type: value.type as PieceType,
    captured: false,
  };
}

export function parseLegalMoves(value: unknown): LegalMoveGroup[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const groups: LegalMoveGroup[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    const { pieceId } = item;
    const from = parsePosition(item.from);
    if (typeof pieceId !== 'string' || pieceId.length === 0 || !from || !Array.isArray(item.targets)) {
      return null;
    }
    const targets: LegalMoveGroup['targets'] = [];
    for (const rawTarget of item.targets) {
      if (!isRecord(rawTarget)) {
        return null;
      }
      const position = parsePosition(rawTarget.position);
      if (!position || typeof rawTarget.kind !== 'string' || !VALID_TARGET_KINDS.has(rawTarget.kind)) {
        return null;
      }
      targets.push({ position, kind: rawTarget.kind as LegalMoveTargetKind });
    }
    groups.push({ pieceId, from, targets });
  }
  return groups;
}

export function parsePublicGameState(value: unknown): PublicGameState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !Array.isArray(value.pieces) ||
    (value.currentTurn !== 'red' && value.currentTurn !== 'black') ||
    (value.winner !== null && value.winner !== 'red' && value.winner !== 'black') ||
    (value.checkedCamp !== null && value.checkedCamp !== 'red' && value.checkedCamp !== 'black') ||
    (value.lastError !== null && typeof value.lastError !== 'string') ||
    typeof value.statusMessage !== 'string' ||
    !Array.isArray(value.actionHistory)
  ) {
    return null;
  }

  const pieces: PublicPiece[] = [];
  const occupied = new Set<string>();
  for (const item of value.pieces) {
    const piece = parsePublicPiece(item);
    if (!piece) {
      return null;
    }
    if (!piece.revealed || !piece.captured) {
      const position = piece.position;
      if (!position) {
        return null;
      }
      const key = `${position.x},${position.y}`;
      if (occupied.has(key)) {
        return null;
      }
      occupied.add(key);
    }
    pieces.push(piece);
  }

  const legalMoves = parseLegalMoves(value.legalMoves ?? []);
  if (!legalMoves) {
    return null;
  }

  const actionHistory = parseHistoryList(value.actionHistory);
  if (!actionHistory) {
    return null;
  }
  const recentAction = value.recentAction ? parseHistoryEntry(value.recentAction) : null;
  if (value.recentAction && !recentAction) {
    return null;
  }

  return {
    pieces,
    currentTurn: value.currentTurn,
    winner: value.winner,
    checkedCamp: value.checkedCamp,
    lastError: value.lastError ?? null,
    statusMessage: value.statusMessage,
    actionHistory,
    recentAction,
    legalMoves,
  };
}

function parseHistoryList(value: unknown): GameHistoryEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: GameHistoryEntry[] = [];
  for (const item of value) {
    const entry = parseHistoryEntry(item);
    if (!entry) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

export function parsePublicMatchSnapshot(value: unknown): PublicMatchSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.matchId !== 'string' ||
    value.matchId.length === 0 ||
    typeof value.stepNumber !== 'number' ||
    !Number.isSafeInteger(value.stepNumber) ||
    value.stepNumber < 0 ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return null;
  }

  const startParameters = parseStartParameters(value.startParameters);
  if (!startParameters) {
    return null;
  }

  const gameState = parsePublicGameState(value.gameState);
  if (!gameState) {
    return null;
  }

  let clock: MatchClockSnapshot | null = null;
  if (value.clock !== undefined && value.clock !== null) {
    clock = parseMatchClockSnapshot(value.clock);
    if (!clock) {
      return null;
    }
  }

  const settlement = value.settlement ? parseMatchSettlement(value.settlement) : null;
  const pendingNegotiation = value.pendingNegotiation ? parsePendingNegotiation(value.pendingNegotiation) : null;
  const drawCooldownUntil = value.drawCooldownUntil ? parseDrawCooldownUntil(value.drawCooldownUntil) : null;
  if (value.drawCooldownUntil !== undefined && !drawCooldownUntil) {
    return null;
  }
  const phraseCooldownUntil = value.phraseCooldownUntil ? parsePhraseCooldownUntil(value.phraseCooldownUntil) : null;
  if (value.phraseCooldownUntil !== undefined && !phraseCooldownUntil) {
    return null;
  }
  const negotiationEvent = value.negotiationEvent ? parseNegotiationEvent(value.negotiationEvent) : null;
  const matchEvents = Array.isArray(value.matchEvents) ? parseMatchEvents(value.matchEvents) ?? [] : [];

  return {
    matchId: value.matchId,
    stepNumber: value.stepNumber,
    revision: value.revision,
    startParameters,
    gameState,
    clock,
    settlement,
    pendingNegotiation,
    drawCooldownUntil: drawCooldownUntil ?? {},
    phraseCooldownUntil: phraseCooldownUntil ?? {},
    negotiationEvent,
    matchEvents,
  };
}

export type { MatchAction, MatchClockSnapshot, MatchEvent, MatchSettlement };
