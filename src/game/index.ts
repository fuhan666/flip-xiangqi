export { BOARD_HEIGHT, BOARD_WIDTH, HIDDEN_OPENING_POSITIONS, INITIAL_REVEALED_POSITIONS, PIECE_SYMBOLS } from './constants.js';
export { applyAction, restartGame, undoLastAction } from './actions.js';
export { createInitialGameState } from './setup.js';
export { createEmptyGameState, getPieceAt, getPieceViewAt, restoreState, snapshotState, cloneStateSnapshot } from './state.js';
export { hasAnyLegalAction, isInCheck, listLegalMoves, validateMove } from './move-rules.js';
export type {
  ActionTimeContext,
  Camp,
  GameAction,
  GameHistoryAction,
  GameHistoryActionKind,
  GameHistoryConsequence,
  GameHistoryEndgameReason,
  GameHistoryEntry,
  GameState,
  GameViewState,
  HistoryPieceSnapshot,
  GameStateSnapshot,
  LegalMoveGroup,
  LegalMoveTarget,
  LegalMoveTargetKind,
  Piece,
  PieceType,
  PieceView,
  Position,
  RuleState,
  UndoEntry,
  UndoPieceState,
} from './types.js';
