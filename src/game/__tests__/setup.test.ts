import { describe, expect, it } from 'vitest';
import { HIDDEN_OPENING_POSITIONS } from '../constants';
import { createInitialGameState } from '../index';
import type { Piece, Position } from '../types';

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function positionKey(position: Position): string {
  return `${position.x},${position.y}`;
}

function expectPiecesToAvoidPositions(pieces: Piece[], forbiddenPositions: Set<string>): void {
  expect(
    pieces.every((piece) => piece.position && !forbiddenPositions.has(positionKey(piece.position))),
  ).toBe(true);
}

const ROOK_FORBIDDEN_POSITIONS = new Set(['4,6', '4,3', '3,9', '5,9', '3,0', '5,0']);
const PAWN_FORBIDDEN_POSITIONS = new Set(['3,9', '5,9', '3,0', '5,0']);
const CANNON_FORBIDDEN_POSITIONS = new Set(['2,9', '6,9', '2,0', '6,0']);

describe('opening setup', () => {
  it('keeps kings fixed and puts all other pieces on unique legal hidden squares', () => {
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
    expect(new Set(hiddenPieces.map((piece) => positionKey(piece.position!))).size).toBe(30);
  });

  it('keeps rooks, pawns, and cannons out of forbidden opening squares', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const state = createInitialGameState(createSeededRng(seed));
      const hiddenPieces = state.pieces.filter((piece) => !piece.revealed);

      expectPiecesToAvoidPositions(
        hiddenPieces.filter((piece) => piece.type === 'rook'),
        ROOK_FORBIDDEN_POSITIONS,
      );
      expectPiecesToAvoidPositions(
        hiddenPieces.filter((piece) => piece.type === 'pawn'),
        PAWN_FORBIDDEN_POSITIONS,
      );
      expectPiecesToAvoidPositions(
        hiddenPieces.filter((piece) => piece.type === 'cannon'),
        CANNON_FORBIDDEN_POSITIONS,
      );
    }
  });
});
