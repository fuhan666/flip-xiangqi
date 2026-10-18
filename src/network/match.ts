/**
 * 权威对局模型与动作仲裁：
 * - 共享确定性种子随机源（uint32 LCG）；
 * - 权威开局初始化、步数递增、行棋方校验与规则校验；
 * - 可传输的对局快照（去除 undoStack）。
 */
import { applyAction, createInitialGameState, snapshotState } from '../game/index.js';
import type { GameAction, GameHistoryEntry, GameState, GameStateSnapshot, Piece, PieceType, Position } from '../game/index.js';
import { parseStartParameters, type StartParameters } from './lobby.js';

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
  startParameters: StartParameters;
  gameState: GameState;
}

export interface MatchSnapshot {
  matchId: string;
  seed: number;
  stepNumber: number;
  startParameters: StartParameters;
  gameState: GameStateSnapshot;
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
    if (!item || typeof item !== 'object') {
      return null;
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.turnNumber !== 'number' ||
      !Number.isInteger(entry.turnNumber) ||
      entry.turnNumber < 1 ||
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
    const action = entry.action as Record<string, unknown>;
    if (action.type === 'flip') {
      if (!parsePosition(action.position)) {
        return null;
      }
    } else if (action.type === 'move') {
      if (!parsePosition(action.from) || !parsePosition(action.to)) {
        return null;
      }
    } else {
      return null;
    }
    actionHistory.push(item as GameHistoryEntry);
  }

  return {
    pieces,
    currentTurn: raw.currentTurn,
    winner: raw.winner,
    checkedCamp: raw.checkedCamp,
    lastError: raw.lastError ?? null,
    statusMessage: raw.statusMessage,
    actionHistory,
    recentAction: (raw.recentAction as GameHistoryEntry | null) ?? null,
  };
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

  const startParameters = parseStartParameters(raw.startParameters);
  if (!startParameters) {
    return null;
  }

  const gameState = parseGameStateSnapshot(raw.gameState);
  if (!gameState) {
    return null;
  }

  return {
    matchId: raw.matchId,
    seed: raw.seed,
    stepNumber: raw.stepNumber,
    startParameters,
    gameState,
  };
}

export function createMatch(input: {
  matchId: string;
  seed: number;
  startParameters: StartParameters;
}): MatchState {
  const rng = createSeededRng(input.seed);
  const gameState = createInitialGameState(rng);

  return {
    matchId: input.matchId,
    seed: input.seed,
    stepNumber: 0,
    startParameters: input.startParameters,
    gameState,
  };
}

export function snapshotMatch(match: MatchState): MatchSnapshot {
  return {
    matchId: match.matchId,
    seed: match.seed,
    stepNumber: match.stepNumber,
    startParameters: match.startParameters,
    gameState: snapshotState(match.gameState),
  };
}

export type MatchActionResult =
  | { ok: true; match: MatchState; resultingAction: GameHistoryEntry }
  | { ok: false; reason: string };

export function applyMatchAction(
  match: MatchState,
  actorMemberId: string,
  action: GameAction,
): MatchActionResult {
  if (match.gameState.winner !== null) {
    return { ok: false, reason: '对局已经结束，请重新开局' };
  }

  const currentTurn = match.gameState.currentTurn;
  const expectedMemberId =
    currentTurn === 'red' ? match.startParameters.redMemberId : match.startParameters.blackMemberId;

  if (actorMemberId !== expectedMemberId) {
    return { ok: false, reason: '非己方回合，请等待对方行动' };
  }

  const nextGameState = applyAction(match.gameState, action);
  if (nextGameState.lastError) {
    return { ok: false, reason: nextGameState.lastError };
  }

  const nextMatch: MatchState = {
    ...match,
    stepNumber: match.stepNumber + 1,
    gameState: nextGameState,
  };

  return {
    ok: true,
    match: nextMatch,
    resultingAction: nextGameState.recentAction!,
  };
}
