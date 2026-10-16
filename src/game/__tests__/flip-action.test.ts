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

  it('flips an opponent piece on my turn and still passes the turn to the opponent', () => {
    const state = createInitialGameState(() => 0.75);
    const hiddenOpponent = state.pieces.find(
      (piece) => piece.camp === 'black' && piece.type !== 'king' && !piece.revealed,
    )!;

    const nextState = applyAction(state, {
      type: 'flip',
      position: hiddenOpponent.position!,
    });

    const revealedPiece = nextState.pieces.find((piece) => piece.id === hiddenOpponent.id)!;
    expect(revealedPiece.camp).toBe('black');
    expect(revealedPiece.revealed).toBe(true);
    expect(revealedPiece.position).toEqual(hiddenOpponent.position);
    expect(nextState.currentTurn).toBe('black');
    expect(nextState.lastError).toBeNull();

    const entry = nextState.actionHistory[nextState.actionHistory.length - 1];
    expect(entry.actor).toBe('red');
    expect(entry.action).toMatchObject({
      type: 'flip',
      position: hiddenOpponent.position,
      piece: { id: hiddenOpponent.id, camp: 'black' },
    });
    expect(entry.nextTurn).toBe('black');
    expect(nextState.undoStack).toHaveLength(1);
  });
});
