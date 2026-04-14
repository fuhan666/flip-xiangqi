import { cloneState, getPieceAt, otherCamp, positionsEqual, restoreState, snapshotState } from './state';
import { createInitialGameState } from './setup';
import { hasAnyLegalAction, isInCheck, validateMove, violatesFacingKings } from './move-rules';
import type {
  Camp,
  GameAction,
  GameHistoryAction,
  GameHistoryConsequence,
  GameHistoryEndgameReason,
  GameHistoryEntry,
  GameState,
  HistoryPieceSnapshot,
  Piece,
} from './types';

interface TurnResolution {
  state: GameState;
  nextTurn: Camp | null;
  checkedCamp: Camp | null;
  winner: Camp | null;
  statusMessage: string;
  endgameReason: GameHistoryEndgameReason | null;
}

function campLabel(camp: Camp): string {
  return camp === 'red' ? '红方' : '黑方';
}

function withError(state: GameState, message: string): GameState {
  return {
    ...cloneState(state),
    lastError: message,
  };
}

function snapshotPiece(piece: Piece): HistoryPieceSnapshot {
  return {
    id: piece.id,
    camp: piece.camp,
    type: piece.type,
    position: piece.position ? { ...piece.position } : null,
  };
}

function recordHistory(
  state: GameState,
  actor: Camp,
  action: GameHistoryAction,
  consequences: GameHistoryConsequence[],
  resolution: TurnResolution,
): GameState {
  const entry: GameHistoryEntry = {
    turnNumber: state.actionHistory.length + 1,
    actor,
    action,
    consequences,
    nextTurn: resolution.nextTurn,
    checkedCamp: resolution.checkedCamp,
    winner: resolution.winner,
    statusMessage: resolution.statusMessage,
  };

  resolution.state.actionHistory = [...resolution.state.actionHistory, entry];
  resolution.state.recentAction = entry;
  resolution.state.undoStack = [...state.undoStack, snapshotState(state)];
  return resolution.state;
}

function finalizeTurn(state: GameState, actingCamp: Camp): TurnResolution {
  const nextTurn = otherCamp(actingCamp);
  const next = cloneState(state);
  next.currentTurn = nextTurn;
  next.lastError = null;

  const opponentKingAlive = next.pieces.some((piece) => piece.type === 'king' && piece.camp === nextTurn && !piece.captured);
  if (!opponentKingAlive) {
    next.winner = actingCamp;
    next.checkedCamp = null;
    next.statusMessage = `${campLabel(actingCamp)}获胜`;
    return {
      state: next,
      nextTurn: null,
      checkedCamp: null,
      winner: actingCamp,
      statusMessage: next.statusMessage,
      endgameReason: 'king-captured',
    };
  }

  const checkedCamp = isInCheck(next, nextTurn) ? nextTurn : null;
  next.checkedCamp = checkedCamp;

  if (checkedCamp && !hasAnyLegalAction(next, nextTurn)) {
    next.winner = actingCamp;
    next.statusMessage = `${campLabel(actingCamp)}将死对手，获得胜利`;
    return {
      state: next,
      nextTurn: null,
      checkedCamp,
      winner: actingCamp,
      statusMessage: next.statusMessage,
      endgameReason: 'checkmate',
    };
  }

  next.statusMessage = checkedCamp
    ? `${campLabel(nextTurn)}被将军，请应将`
    : `${campLabel(nextTurn)}行动`;
  return {
    state: next,
    nextTurn,
    checkedCamp,
    winner: null,
    statusMessage: next.statusMessage,
    endgameReason: null,
  };
}

function applyFlip(state: GameState, action: Extract<GameAction, { type: 'flip' }>): GameState {
  const target = getPieceAt(state, action.position);
  if (!target) {
    return withError(state, '该位置没有可翻开的棋子');
  }
  if (target.revealed) {
    return withError(state, '该位置已经是明子');
  }

  const next = cloneState(state);
  const nextTarget = next.pieces.find((piece) => piece.id === target.id)!;
  nextTarget.revealed = true;

  if (violatesFacingKings(next)) {
    return withError(state, '翻牌后将/帅不能直接照面');
  }
  if (isInCheck(next, state.currentTurn)) {
    return withError(state, '当前处于将军状态，翻牌不能解除将军');
  }

  const resolution = finalizeTurn(next, state.currentTurn);
  const consequences: GameHistoryConsequence[] = [];
  if (resolution.checkedCamp) {
    consequences.push({
      type: 'check',
      camp: resolution.checkedCamp,
    });
  }
  if (resolution.endgameReason) {
    consequences.push({
      type: 'endgame',
      winner: resolution.winner!,
      reason: resolution.endgameReason,
    });
  }

  return recordHistory(
    state,
    state.currentTurn,
    {
      type: 'flip',
      position: { ...action.position },
      piece: snapshotPiece(nextTarget),
    },
    consequences,
    resolution,
  );
}

function applyMove(state: GameState, action: Extract<GameAction, { type: 'move' }>): GameState {
  const piece = getPieceAt(state, action.from);
  if (!piece) {
    return withError(state, '起点没有棋子');
  }
  const validation = validateMove(state, piece, action.to);
  if (!validation.ok) {
    return withError(state, validation.reason ?? '非法着法');
  }

  const next = cloneState(state);
  const movingPiece = next.pieces.find((candidate) => candidate.id === piece.id)!;
  const target = next.pieces.find(
    (candidate) => !candidate.captured && candidate.position && positionsEqual(candidate.position, action.to),
  );
  const capturedPiece = target ? snapshotPiece(target) : null;
  const capturedPosition = target?.position ? { ...target.position } : null;

  if (target) {
    target.captured = true;
    target.position = null;
  }

  movingPiece.position = { ...action.to };
  const resolution = finalizeTurn(next, state.currentTurn);
  const consequences: GameHistoryConsequence[] = [];
  if (capturedPiece && capturedPosition) {
    consequences.push({
      type: 'capture',
      piece: capturedPiece,
      position: capturedPosition,
    });
  }
  if (resolution.checkedCamp) {
    consequences.push({
      type: 'check',
      camp: resolution.checkedCamp,
    });
  }
  if (resolution.endgameReason) {
    consequences.push({
      type: 'endgame',
      winner: resolution.winner!,
      reason: resolution.endgameReason,
    });
  }

  return recordHistory(
    state,
    state.currentTurn,
    {
      type: 'move',
      from: { ...action.from },
      to: { ...action.to },
      piece: snapshotPiece(piece),
    },
    consequences,
    resolution,
  );
}

export function applyAction(state: GameState, action: GameAction): GameState {
  if (state.winner) {
    return withError(state, '对局已经结束，请重新开局');
  }

  if (action.type === 'flip') {
    return applyFlip(state, action);
  }

  return applyMove(state, action);
}

export function undoLastAction(state: GameState): GameState {
  if (state.undoStack.length === 0) {
    return cloneState(state);
  }

  const nextUndoStack = state.undoStack.slice(0, -1);
  const previousState = state.undoStack[state.undoStack.length - 1];
  return restoreState(previousState, nextUndoStack);
}

export function restartGame(rng?: () => number): GameState {
  return createInitialGameState(rng);
}
