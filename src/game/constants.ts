import type { Camp, PieceType, Position } from './types';

export const BOARD_WIDTH = 9;
export const BOARD_HEIGHT = 10;

export const RED_KING_POSITION: Position = { x: 4, y: 9 };
export const BLACK_KING_POSITION: Position = { x: 4, y: 0 };

export const INITIAL_REVEALED_POSITIONS = [BLACK_KING_POSITION, RED_KING_POSITION] as const;

export const HIDDEN_OPENING_POSITIONS: Position[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 3, y: 0 },
  { x: 5, y: 0 },
  { x: 6, y: 0 },
  { x: 7, y: 0 },
  { x: 8, y: 0 },
  { x: 1, y: 2 },
  { x: 7, y: 2 },
  { x: 0, y: 3 },
  { x: 2, y: 3 },
  { x: 4, y: 3 },
  { x: 6, y: 3 },
  { x: 8, y: 3 },
  { x: 0, y: 6 },
  { x: 2, y: 6 },
  { x: 4, y: 6 },
  { x: 6, y: 6 },
  { x: 8, y: 6 },
  { x: 1, y: 7 },
  { x: 7, y: 7 },
  { x: 0, y: 9 },
  { x: 1, y: 9 },
  { x: 2, y: 9 },
  { x: 3, y: 9 },
  { x: 5, y: 9 },
  { x: 6, y: 9 },
  { x: 7, y: 9 },
  { x: 8, y: 9 },
];

const PIECE_DISTRIBUTION: Array<[PieceType, number]> = [
  ['advisor', 2],
  ['elephant', 2],
  ['horse', 2],
  ['rook', 2],
  ['cannon', 2],
  ['pawn', 5],
];

export const NON_KING_PIECES: Array<{ id: string; camp: Camp; type: PieceType }> = (['black', 'red'] as Camp[]).flatMap((camp) =>
  PIECE_DISTRIBUTION.flatMap(([type, count]) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${camp}-${type}-${index + 1}`,
      camp,
      type,
    })),
  ),
);

export const PIECE_SYMBOLS: Record<Camp, Record<PieceType, string>> = {
  red: {
    king: '帅',
    advisor: '仕',
    elephant: '相',
    horse: '傌',
    rook: '俥',
    cannon: '炮',
    pawn: '兵',
  },
  black: {
    king: '将',
    advisor: '士',
    elephant: '象',
    horse: '馬',
    rook: '車',
    cannon: '砲',
    pawn: '卒',
  },
};
