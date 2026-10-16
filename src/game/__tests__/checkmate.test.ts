import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyGameState, isInCheck, undoLastAction } from '../index';
import type { GameState, Piece } from '../types';

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

function stateWithPieces(pieces: Piece[], currentTurn: GameState['currentTurn'] = 'red'): GameState {
  return createEmptyGameState({ pieces, currentTurn });
}

describe('check and endgame rules', () => {
  it('detects check against the black king', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 4, y: 5 } }),
    ]);

    expect(isInCheck(state, 'black')).toBe(true);
  });

  it('rejects a move that leaves the current player in check', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 4, y: 8 } }),
      piece({ id: 'black-rook', camp: 'black', type: 'rook', position: { x: 4, y: 4 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 4, y: 8 },
      to: { x: 5, y: 8 },
    });

    expect(nextState.lastError).toContain('将军');
  });

  it('ends the game when a king is captured', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 4, y: 1 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 4, y: 1 },
      to: { x: 4, y: 0 },
    });

    expect(nextState.winner).toBe('red');
    expect(nextState.statusMessage).toContain('获胜');
  });

  function createCheckmateReadyState(): GameState {
    return stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 3, y: 2 } }),
      piece({ id: 'red-pawn-left', camp: 'red', type: 'pawn', position: { x: 3, y: 1 } }),
      piece({ id: 'red-pawn-right', camp: 'red', type: 'pawn', position: { x: 5, y: 1 } }),
      piece({ id: 'red-pawn-center', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
    ]);
  }

  it('checkmates the lone king with the final rook move and keeps the king on the board', () => {
    const state = createCheckmateReadyState();

    expect(isInCheck(state, 'black')).toBe(false);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 3, y: 2 },
      to: { x: 4, y: 2 },
    });

    expect(nextState.lastError).toBeNull();
    expect(nextState.winner).toBe('red');
    expect(nextState.checkedCamp).toBe('black');
    expect(nextState.statusMessage).toBe('红方将死对手，获得胜利');
    expect(nextState.currentTurn).toBe('black');

    const blackKing = nextState.pieces.find((item) => item.id === 'black-king')!;
    expect(blackKing.captured).toBe(false);
    expect(blackKing.position).toEqual({ x: 4, y: 0 });
    expect(nextState.pieces.filter((item) => item.captured)).toHaveLength(0);

    const entry = nextState.actionHistory[nextState.actionHistory.length - 1];
    expect(entry.turnNumber).toBe(1);
    expect(entry.nextTurn).toBeNull();
    expect(entry.winner).toBe('red');
    expect(entry.consequences).toContainEqual({ type: 'check', camp: 'black' });
    expect(entry.consequences).toContainEqual({ type: 'endgame', winner: 'red', reason: 'checkmate' });
  });

  it('rejects further actions after checkmate and restores the position on undo', () => {
    const state = createCheckmateReadyState();
    const mated = applyAction(state, {
      type: 'move',
      from: { x: 3, y: 2 },
      to: { x: 4, y: 2 },
    });

    const rejected = applyAction(mated, {
      type: 'move',
      from: { x: 4, y: 2 },
      to: { x: 4, y: 0 },
    });

    expect(rejected.lastError).toBe('对局已经结束，请重新开局');
    expect(rejected.winner).toBe('red');
    expect(rejected.actionHistory).toHaveLength(1);
    expect(rejected.pieces.find((item) => item.id === 'black-king')?.captured).toBe(false);

    const undone = undoLastAction(mated);
    expect(undone.winner).toBeNull();
    expect(undone.checkedCamp).toBeNull();
    expect(undone.currentTurn).toBe('red');
    expect(undone.actionHistory).toHaveLength(0);
    expect(undone.pieces.find((item) => item.id === 'red-rook')?.position).toEqual({ x: 3, y: 2 });
  });
});
