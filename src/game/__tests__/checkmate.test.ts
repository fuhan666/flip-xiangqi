import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyGameState, isInCheck } from '../index';
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
});
