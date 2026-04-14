import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyGameState, listLegalMoves } from '../index';
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

describe('movement rules', () => {
  it('lets a rook move in straight lines until blocked by hidden pieces', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      piece({ id: 'hidden-blocker', camp: 'black', type: 'pawn', position: { x: 0, y: 7 }, revealed: false }),
    ]);

    const legalMoves = listLegalMoves(state, 'red-rook');

    expect(legalMoves).toContainEqual({ x: 0, y: 8 });
    expect(legalMoves).not.toContainEqual({ x: 0, y: 7 });
  });

  it('rejects knight movement when the horse leg is blocked', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-horse', camp: 'red', type: 'horse', position: { x: 1, y: 7 } }),
      piece({ id: 'horse-leg', camp: 'red', type: 'pawn', position: { x: 1, y: 6 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 1, y: 7 },
      to: { x: 2, y: 5 },
    });

    expect(nextState.lastError).toContain('马腿');
  });

  it('allows cannons to capture with exactly one screen', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
      piece({ id: 'red-cannon', camp: 'red', type: 'cannon', position: { x: 1, y: 7 } }),
      piece({ id: 'screen', camp: 'red', type: 'pawn', position: { x: 1, y: 5 } }),
      piece({ id: 'target', camp: 'black', type: 'rook', position: { x: 1, y: 2 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 1, y: 7 },
      to: { x: 1, y: 2 },
    });

    expect(nextState.lastError).toBeNull();
    expect(nextState.pieces.find((item) => item.id === 'red-cannon')?.position).toEqual({ x: 1, y: 2 });
    expect(nextState.pieces.find((item) => item.id === 'target')?.captured).toBe(true);
  });
});
