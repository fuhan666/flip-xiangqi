import { clonePieces, cloneState, getPieceAt, otherCamp, positionsEqual } from './state.js';
import { createInitialGameState } from './setup.js';
import { hasAnyLegalAction, isInCheck, validateMove, violatesFacingKings } from './move-rules.js';
import type {
  ActionTimeContext,
  Camp,
  GameAction,
  GameHistoryAction,
  GameHistoryActionKind,
  GameHistoryConsequence,
  GameHistoryEndgameReason,
  GameHistoryEntry,
  GameState,
  HistoryPieceSnapshot,
  Piece,
  UndoEntry,
} from './types.js';

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

/** 撤销点只记录本步改变棋子的前置值与被覆盖的标量，不携带历史或另一条撤销栈。 */
function makeUndoEntry(state: GameState, changedPieceIds: string[]): UndoEntry {
  return {
    historyLength: state.actionHistory.length,
    pieces: changedPieceIds.map((id) => {
      const piece = state.pieces.find((candidate) => candidate.id === id)!;
      return {
        id,
        revealed: piece.revealed,
        captured: piece.captured,
        position: piece.position ? { ...piece.position } : null,
      };
    }),
    currentTurn: state.currentTurn,
    winner: state.winner,
    checkedCamp: state.checkedCamp,
    lastError: state.lastError,
    statusMessage: state.statusMessage,
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
  timeContext: ActionTimeContext | number | null | undefined,
  changedPieceIds: string[],
): GameState {
  const stepNumber = state.actionHistory.length + 1;
  const turnNumber = stepNumber;
  let kind: GameHistoryActionKind;
  if (action.type === 'flip') {
    kind = 'flip';
  } else if (consequences.some((c) => c.type === 'capture')) {
    kind = 'capture';
  } else {
    kind = 'move';
  }

  let durationSeconds: number | null = null;
  if (typeof timeContext === 'number' && Number.isFinite(timeContext) && timeContext >= 0) {
    durationSeconds = timeContext;
  } else if (
    timeContext &&
    typeof timeContext === 'object' &&
    typeof timeContext.durationSeconds === 'number' &&
    Number.isFinite(timeContext.durationSeconds) &&
    timeContext.durationSeconds >= 0
  ) {
    durationSeconds = timeContext.durationSeconds;
  }

  const entry: GameHistoryEntry = {
    stepNumber,
    turnNumber,
    kind,
    actor,
    action,
    consequences,
    nextTurn: resolution.nextTurn,
    checkedCamp: resolution.checkedCamp,
    winner: resolution.winner,
    statusMessage: resolution.statusMessage,
    durationSeconds,
  };

  resolution.state.actionHistory = [...state.actionHistory, entry];
  resolution.state.recentAction = entry;
  resolution.state.undoStack = [...state.undoStack, makeUndoEntry(state, changedPieceIds)];
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

function applyFlip(
  state: GameState,
  action: Extract<GameAction, { type: 'flip' }>,
  timeContext?: ActionTimeContext | number | null,
): GameState {
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
      from: { ...action.position },
      to: { ...action.position },
      piece: snapshotPiece(nextTarget),
    },
    consequences,
    resolution,
    timeContext,
    [target.id],
  );
}

function applyMove(
  state: GameState,
  action: Extract<GameAction, { type: 'move' }>,
  timeContext?: ActionTimeContext | number | null,
): GameState {
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
    timeContext,
    target ? [piece.id, target.id] : [piece.id],
  );
}

export function applyAction(
  state: GameState,
  action: GameAction,
  timeContext?: ActionTimeContext | number | null,
): GameState {
  if (state.winner) {
    return withError(state, '对局已经结束，请重新开局');
  }

  if (action.type === 'flip') {
    return applyFlip(state, action, timeContext);
  }

  return applyMove(state, action, timeContext);
}

export function undoLastAction(state: GameState): GameState {
  const undoEntry = state.undoStack[state.undoStack.length - 1];
  if (!undoEntry) {
    return cloneState(state);
  }

  const pieces = clonePieces(state.pieces);
  for (const saved of undoEntry.pieces) {
    const piece = pieces.find((candidate) => candidate.id === saved.id)!;
    piece.revealed = saved.revealed;
    piece.captured = saved.captured;
    piece.position = saved.position ? { ...saved.position } : null;
  }

  // 裁剪有效历史尾部，recentAction 从剩余历史恢复。
  const actionHistory = state.actionHistory.slice(0, undoEntry.historyLength);
  return {
    pieces,
    currentTurn: undoEntry.currentTurn,
    winner: undoEntry.winner,
    checkedCamp: undoEntry.checkedCamp,
    lastError: undoEntry.lastError,
    statusMessage: undoEntry.statusMessage,
    actionHistory,
    recentAction: actionHistory.length > 0 ? actionHistory[actionHistory.length - 1] : null,
    undoStack: state.undoStack.slice(0, -1),
  };
}

export function restartGame(rng?: () => number): GameState {
  return createInitialGameState(rng);
}
