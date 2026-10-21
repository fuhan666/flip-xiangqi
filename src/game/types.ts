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
  from?: Position;
  to?: Position;
  piece: HistoryPieceSnapshot;
}

export interface MoveHistoryAction {
  type: 'move';
  from: Position;
  to: Position;
  piece: HistoryPieceSnapshot;
}

export type GameHistoryAction = FlipHistoryAction | MoveHistoryAction;

export type GameHistoryActionKind = 'flip' | 'move' | 'capture';

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

export interface ActionTimeContext {
  durationSeconds?: number | null;
}

export interface GameHistoryEntry {
  stepNumber: number;
  turnNumber: number;
  kind: GameHistoryActionKind;
  actor: Camp;
  action: GameHistoryAction;
  consequences: GameHistoryConsequence[];
  nextTurn: Camp | null;
  checkedCamp: Camp | null;
  winner: Camp | null;
  statusMessage: string;
  durationSeconds: number | null;
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

/** 规则计算所需的最小局面视图：只含棋子与行棋方，不携带历史、撤销或开局数据。 */
export interface RuleState {
  pieces: Piece[];
  currentTurn: Camp;
}

/** 撤销点中单枚棋子的前置值（仅记录本步改变的棋子）。 */
export interface UndoPieceState {
  id: string;
  revealed: boolean;
  captured: boolean;
  position: Position | null;
}

/**
 * 紧凑撤销记录：只保存本步改变棋子的旧值与被覆盖的标量状态。
 * 有效动作历史仅保留一份权威副本，撤销点不再嵌套完整快照。
 */
export interface UndoEntry {
  historyLength: number;
  pieces: UndoPieceState[];
  currentTurn: Camp;
  winner: Camp | null;
  checkedCamp: Camp | null;
  lastError: string | null;
  statusMessage: string;
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
  undoStack: UndoEntry[];
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
