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

/**
 * 展示用棋子视图：暗子只暴露位置与不透明标识，
 * camp/type/captured 仅在 revealed 为 true（已明子）时提供。
 * 本地完整 `Piece` 与联机公开棋子都可直接作为该视图渲染。
 */
export interface PieceView {
  id: string;
  position: Position | null;
  revealed: boolean;
  camp?: Camp;
  type?: PieceType;
  captured?: boolean;
}

export type LegalMoveTargetKind = 'empty' | 'capture';

export interface LegalMoveTarget {
  position: Position;
  kind: LegalMoveTargetKind;
}

/** 服务端为该行棋方明子给出的落点提示；仅用于展示，提交仍由服务端裁决。 */
export interface LegalMoveGroup {
  pieceId: string;
  from: Position;
  targets: LegalMoveTarget[];
}

/** 棋盘/状态面板所需的只读局面视图：不包含撤销栈、种子或开局帧。 */
export interface GameViewState {
  pieces: PieceView[];
  currentTurn: Camp;
  winner: Camp | null;
  checkedCamp: Camp | null;
  lastError: string | null;
  statusMessage: string;
  actionHistory: GameHistoryEntry[];
  recentAction: GameHistoryEntry | null;
  legalMoves?: LegalMoveGroup[];
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
