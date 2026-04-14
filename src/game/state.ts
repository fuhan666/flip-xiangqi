import { BLACK_KING_POSITION, NON_KING_PIECES, RED_KING_POSITION } from './constants';
import type { Camp, GameState, Piece, Position } from './types';

export function createEmptyGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    pieces: [],
    currentTurn: 'red',
    winner: null,
    checkedCamp: null,
    lastError: null,
    statusMessage: '红方先行',
    ...overrides,
  };
}

export function createBasePieces(): Piece[] {
  return [
    {
      id: 'black-king',
      camp: 'black',
      type: 'king',
      position: { ...BLACK_KING_POSITION },
      revealed: true,
      captured: false,
    },
    {
      id: 'red-king',
      camp: 'red',
      type: 'king',
      position: { ...RED_KING_POSITION },
      revealed: true,
      captured: false,
    },
    ...NON_KING_PIECES.map((piece) => ({
      ...piece,
      position: null,
      revealed: false,
      captured: false,
    })),
  ];
}

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    pieces: state.pieces.map((piece) => ({
      ...piece,
      position: piece.position ? { ...piece.position } : null,
    })),
  };
}

export function positionsEqual(left: Position, right: Position): boolean {
  return left.x === right.x && left.y === right.y;
}

export function getPieceAt(state: GameState, position: Position): Piece | undefined {
  return state.pieces.find((piece) => !piece.captured && piece.position && positionsEqual(piece.position, position));
}

export function findKing(state: GameState, camp: Camp): Piece | undefined {
  return state.pieces.find((piece) => piece.type === 'king' && piece.camp === camp && !piece.captured);
}

export function otherCamp(camp: Camp): Camp {
  return camp === 'red' ? 'black' : 'red';
}
