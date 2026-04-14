import { HIDDEN_OPENING_POSITIONS } from './constants';
import { createBasePieces, createEmptyGameState } from './state';
import type { GameState } from './types';

function shuffle<T>(items: T[], rng: () => number): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export function createInitialGameState(rng: () => number = Math.random): GameState {
  const pieces = createBasePieces();
  const hiddenPositions = shuffle(HIDDEN_OPENING_POSITIONS, rng);
  const hiddenPieces = pieces.filter((piece) => piece.type !== 'king');

  hiddenPieces.forEach((piece, index) => {
    piece.position = { ...hiddenPositions[index] };
  });

  return createEmptyGameState({
    pieces,
    statusMessage: '红方先行，请翻牌或移动明子',
  });
}
