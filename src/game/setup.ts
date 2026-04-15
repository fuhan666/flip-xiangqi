import { HIDDEN_OPENING_FORBIDDEN_POSITIONS_BY_TYPE, HIDDEN_OPENING_POSITIONS } from './constants';
import { createBasePieces, createEmptyGameState } from './state';
import type { GameState, Piece, PieceType, Position } from './types';

function shuffle<T>(items: T[], rng: () => number): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function positionKey(position: Position): string {
  return `${position.x},${position.y}`;
}

const HIDDEN_PIECE_PLACEMENT_PRIORITY: PieceType[] = ['rook', 'cannon', 'pawn', 'advisor', 'elephant', 'horse'];

const HIDDEN_OPENING_FORBIDDEN_POSITION_KEYS_BY_TYPE = Object.fromEntries(
  Object.entries(HIDDEN_OPENING_FORBIDDEN_POSITIONS_BY_TYPE).map(([type, positions]) => [
    type,
    new Set(positions.map(positionKey)),
  ]),
) as Partial<Record<PieceType, Set<string>>>;

function getPlacementPriority(type: PieceType): number {
  const index = HIDDEN_PIECE_PLACEMENT_PRIORITY.indexOf(type);
  return index === -1 ? HIDDEN_PIECE_PLACEMENT_PRIORITY.length : index;
}

function takeRandomOpeningPosition(
  piece: Piece,
  availablePositions: Position[],
  rng: () => number,
): Position {
  const forbiddenPositions = HIDDEN_OPENING_FORBIDDEN_POSITION_KEYS_BY_TYPE[piece.type];
  const legalPositions = availablePositions.filter(
    (position) => !forbiddenPositions?.has(positionKey(position)),
  );

  if (legalPositions.length === 0) {
    throw new Error(`No legal opening position available for ${piece.type}`);
  }

  return legalPositions[Math.floor(rng() * legalPositions.length)];
}

export function createInitialGameState(rng: () => number = Math.random): GameState {
  const pieces = createBasePieces();
  const hiddenPieces = pieces
    .filter((piece) => piece.type !== 'king')
    .sort((left, right) => getPlacementPriority(left.type) - getPlacementPriority(right.type));
  const availablePositions = shuffle(HIDDEN_OPENING_POSITIONS, rng);

  hiddenPieces.forEach((piece) => {
    const position = takeRandomOpeningPosition(piece, availablePositions, rng);
    piece.position = { ...position };

    const usedPositionIndex = availablePositions.findIndex(
      (candidate) => candidate.x === position.x && candidate.y === position.y,
    );
    availablePositions.splice(usedPositionIndex, 1);
  });

  return createEmptyGameState({
    pieces,
    statusMessage: '红方先行，请翻牌或移动明子',
  });
}
