import { cloneState, getPieceAt, otherCamp, positionsEqual } from './state';
import { createInitialGameState } from './setup';
import { hasAnyLegalAction, isInCheck, validateMove, violatesFacingKings } from './move-rules';
import type { Camp, GameAction, GameState } from './types';

function campLabel(camp: Camp): string {
  return camp === 'red' ? '红方' : '黑方';
}

function withError(state: GameState, message: string): GameState {
  return {
    ...cloneState(state),
    lastError: message,
  };
}

function finalizeTurn(state: GameState, actingCamp: Camp): GameState {
  const nextTurn = otherCamp(actingCamp);
  const next = cloneState(state);
  next.currentTurn = nextTurn;
  next.lastError = null;

  const opponentKingAlive = next.pieces.some((piece) => piece.type === 'king' && piece.camp === nextTurn && !piece.captured);
  if (!opponentKingAlive) {
    next.winner = actingCamp;
    next.checkedCamp = null;
    next.statusMessage = `${campLabel(actingCamp)}获胜`; 
    return next;
  }

  const checkedCamp = isInCheck(next, nextTurn) ? nextTurn : null;
  next.checkedCamp = checkedCamp;

  if (checkedCamp && !hasAnyLegalAction(next, nextTurn)) {
    next.winner = actingCamp;
    next.statusMessage = `${campLabel(actingCamp)}将死对手，获得胜利`;
    return next;
  }

  next.statusMessage = checkedCamp
    ? `${campLabel(nextTurn)}被将军，请应将`
    : `${campLabel(nextTurn)}行动`;
  return next;
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

  return finalizeTurn(next, state.currentTurn);
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

  if (target) {
    target.captured = true;
    target.position = null;
  }

  movingPiece.position = { ...action.to };
  return finalizeTurn(next, state.currentTurn);
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

export function restartGame(rng?: () => number): GameState {
  return createInitialGameState(rng);
}
