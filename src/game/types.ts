export type Camp = 'red' | 'black';

export type PieceType =
  | 'king'
  | 'advisor'
  | 'elephant'
  | 'horse'
  | 'rook'
  | 'cannon'
  | 'pawn';

export interface Position {
  x: number;
  y: number;
}

export interface Piece {
  id: string;
  camp: Camp;
  type: PieceType;
  position: Position | null;
  revealed: boolean;
  captured: boolean;
}

export interface GameState {
  pieces: Piece[];
  currentTurn: Camp;
  winner: Camp | null;
  checkedCamp: Camp | null;
  lastError: string | null;
  statusMessage: string;
}

export interface FlipAction {
  type: 'flip';
  position: Position;
}

export interface MoveAction {
  type: 'move';
  from: Position;
  to: Position;
}

export type GameAction = FlipAction | MoveAction;

export interface MoveValidationResult {
  ok: boolean;
  reason?: string;
}
