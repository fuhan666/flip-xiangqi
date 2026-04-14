import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyGameState } from '../index';
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

describe('capture restrictions', () => {
  it('forbids capturing hidden pieces directly', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      piece({ id: 'hidden-target', camp: 'black', type: 'pawn', position: { x: 0, y: 7 }, revealed: false }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 0, y: 9 },
      to: { x: 0, y: 7 },
    });

    expect(nextState.lastError).toContain('暗子');
  });

  it('rejects cannon captures when the target is hidden even with a screen', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-cannon', camp: 'red', type: 'cannon', position: { x: 1, y: 7 } }),
      piece({ id: 'screen', camp: 'red', type: 'pawn', position: { x: 1, y: 5 } }),
      piece({ id: 'hidden-target', camp: 'black', type: 'rook', position: { x: 1, y: 2 }, revealed: false }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 1, y: 7 },
      to: { x: 1, y: 2 },
    });

    expect(nextState.lastError).toContain('暗子');
  });
});
