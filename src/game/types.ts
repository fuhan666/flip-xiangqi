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

export interface HistoryPieceSnapshot {
  id: string;
  camp: Camp;
  type: PieceType;
  position: Position | null;
}

export interface FlipHistoryAction {
  type: 'flip';
  position: Position;
  piece: HistoryPieceSnapshot;
}

export interface MoveHistoryAction {
  type: 'move';
  from: Position;
  to: Position;
  piece: HistoryPieceSnapshot;
}

export type GameHistoryAction = FlipHistoryAction | MoveHistoryAction;

export interface CaptureHistoryConsequence {
  type: 'capture';
  piece: HistoryPieceSnapshot;
  position: Position;
}

export interface CheckHistoryConsequence {
  type: 'check';
  camp: Camp;
}

export type GameHistoryEndgameReason = 'king-captured' | 'checkmate';

export interface EndgameHistoryConsequence {
  type: 'endgame';
  winner: Camp;
  reason: GameHistoryEndgameReason;
}

export type GameHistoryConsequence =
  | CaptureHistoryConsequence
  | CheckHistoryConsequence
  | EndgameHistoryConsequence;

export interface GameHistoryEntry {
  turnNumber: number;
  actor: Camp;
  action: GameHistoryAction;
  consequences: GameHistoryConsequence[];
  nextTurn: Camp | null;
  checkedCamp: Camp | null;
  winner: Camp | null;
  statusMessage: string;
}

export interface GameStateSnapshot {
  pieces: Piece[];
  currentTurn: Camp;
  winner: Camp | null;
  checkedCamp: Camp | null;
  lastError: string | null;
  statusMessage: string;
  actionHistory: GameHistoryEntry[];
  recentAction: GameHistoryEntry | null;
}
export interface GameState {
  pieces: Piece[];
  currentTurn: Camp;
  winner: Camp | null;
  checkedCamp: Camp | null;
  lastError: string | null;
  statusMessage: string;
  actionHistory: GameHistoryEntry[];
  recentAction: GameHistoryEntry | null;
  undoStack: GameStateSnapshot[];
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
