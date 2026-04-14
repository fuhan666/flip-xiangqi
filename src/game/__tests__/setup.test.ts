import { describe, expect, it } from 'vitest';
import { HIDDEN_OPENING_POSITIONS } from '../constants';
import { createInitialGameState } from '../index';

describe('opening setup', () => {
  it('keeps kings fixed and puts all other pieces on legal hidden squares', () => {
    const state = createInitialGameState(() => 0.42);

    const redKing = state.pieces.find((piece) => piece.id === 'red-king')!;
    const blackKing = state.pieces.find((piece) => piece.id === 'black-king')!;

    expect(redKing.position).toEqual({ x: 4, y: 9 });
    expect(blackKing.position).toEqual({ x: 4, y: 0 });

    const hiddenPieces = state.pieces.filter((piece) => !piece.revealed);
    expect(hiddenPieces).toHaveLength(30);
    expect(hiddenPieces.every((piece) => piece.position !== null)).toBe(true);
    expect(
      hiddenPieces.every((piece) =>
        HIDDEN_OPENING_POSITIONS.some(
          (position) => position.x === piece.position!.x && position.y === piece.position!.y,
        ),
      ),
    ).toBe(true);
  });
});
