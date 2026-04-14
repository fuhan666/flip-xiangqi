import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyGameState, createInitialGameState, undoLastAction } from '../index';
import type { GameState, Piece } from '../types';

type UndoableState = GameState & {
  actionHistory?: unknown[];
  recentAction?: unknown | null;
};

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

describe('undo action', () => {
  it('undoes a successful flip and restores the previous turn state', () => {
    const initialState = createInitialGameState(() => 0);
    const hiddenPiece = initialState.pieces.find((candidate) => !candidate.revealed)!;

    const progressedState = applyAction(initialState, {
      type: 'flip',
      position: hiddenPiece.position!,
    }) as UndoableState;

    expect(progressedState.currentTurn).toBe('black');
    expect(progressedState.actionHistory ?? []).toHaveLength(1);

    const restoredState = undoLastAction(progressedState) as UndoableState;
    const restoredPiece = restoredState.pieces.find((candidate) => candidate.id === hiddenPiece.id)!;

    expect(restoredPiece.revealed).toBe(false);
    expect(restoredPiece.position).toEqual(hiddenPiece.position);
    expect(restoredState.currentTurn).toBe(initialState.currentTurn);
    expect(restoredState.checkedCamp).toBe(initialState.checkedCamp);
    expect(restoredState.winner).toBe(initialState.winner);
    expect(restoredState.statusMessage).toBe(initialState.statusMessage);
    expect(restoredState.lastError).toBe(initialState.lastError);
    expect(restoredState.actionHistory ?? []).toHaveLength(0);
    expect(restoredState.recentAction ?? null).toBeNull();
  });

  it('undoes a checking capture and restores both pieces and derived rule state', () => {
    const initialState = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 4, y: 5 } }),
      piece({ id: 'black-rook', camp: 'black', type: 'rook', position: { x: 4, y: 3 } }),
    ]);

    const progressedState = applyAction(initialState, {
      type: 'move',
      from: { x: 4, y: 5 },
      to: { x: 4, y: 3 },
    }) as UndoableState;

    expect(progressedState.checkedCamp).toBe('black');
    expect(progressedState.currentTurn).toBe('black');
    expect(progressedState.pieces.find((candidate) => candidate.id === 'black-rook')?.captured).toBe(true);

    const restoredState = undoLastAction(progressedState) as UndoableState;
    const redRook = restoredState.pieces.find((candidate) => candidate.id === 'red-rook')!;
    const blackRook = restoredState.pieces.find((candidate) => candidate.id === 'black-rook')!;

    expect(redRook.position).toEqual({ x: 4, y: 5 });
    expect(blackRook.captured).toBe(false);
    expect(blackRook.position).toEqual({ x: 4, y: 3 });
    expect(restoredState.currentTurn).toBe(initialState.currentTurn);
    expect(restoredState.checkedCamp).toBeNull();
    expect(restoredState.winner).toBeNull();
    expect(restoredState.statusMessage).toBe(initialState.statusMessage);
    expect(restoredState.actionHistory ?? []).toHaveLength(0);
    expect(restoredState.recentAction ?? null).toBeNull();
  });

  it('does not create a new undo point for illegal actions', () => {
    const initialState = createInitialGameState(() => 0);
    const hiddenPiece = initialState.pieces.find((candidate) => !candidate.revealed)!;
    const afterFlip = applyAction(initialState, {
      type: 'flip',
      position: hiddenPiece.position!,
    }) as UndoableState;

    const invalidState = applyAction(afterFlip, {
      type: 'move',
      from: { x: 4, y: 1 },
      to: { x: 4, y: 2 },
    }) as UndoableState;

    expect(invalidState.lastError).toContain('起点没有棋子');
    expect(invalidState.actionHistory ?? []).toHaveLength(1);

    const restoredState = undoLastAction(invalidState) as UndoableState;
    const restoredPiece = restoredState.pieces.find((candidate) => candidate.id === hiddenPiece.id)!;

    expect(restoredPiece.revealed).toBe(false);
    expect(restoredState.currentTurn).toBe(initialState.currentTurn);
    expect(restoredState.lastError).toBeNull();
    expect(restoredState.actionHistory ?? []).toHaveLength(0);
    expect(restoredState.recentAction ?? null).toBeNull();
  });
});
