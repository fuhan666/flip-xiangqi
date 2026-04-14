import { describe, expect, it } from 'vitest';
import { applyAction, createInitialGameState } from '../index';

describe('flip action', () => {
  it('reveals a hidden piece and advances the turn without moving it', () => {
    const state = createInitialGameState(() => 0);
    const hiddenPiece = state.pieces.find((piece) => !piece.revealed)!;

    const nextState = applyAction(state, {
      type: 'flip',
      position: hiddenPiece.position!,
    });

    const revealedPiece = nextState.pieces.find((piece) => piece.id === hiddenPiece.id)!;
    expect(revealedPiece.revealed).toBe(true);
    expect(revealedPiece.position).toEqual(hiddenPiece.position);
    expect(nextState.currentTurn).toBe('black');
    expect(nextState.lastError).toBeNull();
  });
});
