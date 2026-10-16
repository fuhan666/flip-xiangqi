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
  it('captures a revealed enemy piece and records the capture', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 4 } }),
      piece({ id: 'black-rook', camp: 'black', type: 'rook', position: { x: 0, y: 1 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 0, y: 4 },
      to: { x: 0, y: 1 },
    });

    expect(nextState.lastError).toBeNull();
    expect(nextState.currentTurn).toBe('black');

    const attacker = nextState.pieces.find((item) => item.id === 'red-rook')!;
    const target = nextState.pieces.find((item) => item.id === 'black-rook')!;
    expect(attacker.position).toEqual({ x: 0, y: 1 });
    expect(target.captured).toBe(true);
    expect(target.position).toBeNull();
    expect(nextState.pieces.filter((item) => item.captured).map((item) => item.id)).toEqual(['black-rook']);

    const entry = nextState.actionHistory[nextState.actionHistory.length - 1];
    expect(entry.turnNumber).toBe(1);
    expect(entry.actor).toBe('red');
    expect(entry.consequences).toContainEqual({
      type: 'capture',
      piece: expect.objectContaining({ id: 'black-rook', camp: 'black', type: 'rook' }),
      position: { x: 0, y: 1 },
    });
  });

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
    expect(nextState.currentTurn).toBe('red');
    expect(nextState.actionHistory).toHaveLength(0);
    expect(nextState.pieces.find((item) => item.id === 'red-rook')?.position).toEqual({ x: 0, y: 9 });
    expect(nextState.pieces.find((item) => item.id === 'hidden-target')?.captured).toBe(false);
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

  it('rejects cannon captures with no screen between cannon and target', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-cannon', camp: 'red', type: 'cannon', position: { x: 1, y: 7 } }),
      piece({ id: 'target', camp: 'black', type: 'rook', position: { x: 1, y: 4 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 1, y: 7 },
      to: { x: 1, y: 4 },
    });

    expect(nextState.lastError).toContain('架子');
    expect(nextState.pieces.find((item) => item.id === 'target')?.captured).toBe(false);
    expect(nextState.currentTurn).toBe('red');
  });

  it('rejects cannon captures with two screens between cannon and target', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-cannon', camp: 'red', type: 'cannon', position: { x: 1, y: 8 } }),
      piece({ id: 'screen-a', camp: 'red', type: 'pawn', position: { x: 1, y: 6 } }),
      piece({ id: 'screen-b', camp: 'red', type: 'pawn', position: { x: 1, y: 3 } }),
      piece({ id: 'target', camp: 'black', type: 'rook', position: { x: 1, y: 1 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 1, y: 8 },
      to: { x: 1, y: 1 },
    });

    expect(nextState.lastError).toContain('架子');
    expect(nextState.pieces.find((item) => item.id === 'target')?.captured).toBe(false);
    expect(nextState.pieces.find((item) => item.id === 'red-cannon')?.position).toEqual({ x: 1, y: 8 });
    expect(nextState.currentTurn).toBe('red');
    expect(nextState.actionHistory).toHaveLength(0);
  });

  it('keeps the full state unchanged when an action is rejected', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 } }),
      piece({ id: 'hidden-blocker', camp: 'black', type: 'pawn', position: { x: 0, y: 3 }, revealed: false }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 0, y: 5 },
      to: { x: 0, y: 1 },
    });

    expect(nextState.lastError).toBe('路径被阻挡');
    expect(nextState.currentTurn).toBe('red');
    expect(nextState.winner).toBeNull();
    expect(nextState.checkedCamp).toBeNull();
    expect(nextState.actionHistory).toHaveLength(0);
    expect(nextState.recentAction).toBeNull();
    expect(nextState.undoStack).toHaveLength(0);
    expect(nextState.pieces.map((item) => ({ id: item.id, position: item.position, captured: item.captured }))).toEqual(
      state.pieces.map((item) => ({ id: item.id, position: item.position, captured: item.captured })),
    );
  });
});
