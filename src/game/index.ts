export { BOARD_HEIGHT, BOARD_WIDTH, HIDDEN_OPENING_POSITIONS, INITIAL_REVEALED_POSITIONS, PIECE_SYMBOLS } from './constants.js';
export { applyAction, restartGame, undoLastAction } from './actions.js';
export { createInitialGameState } from './setup.js';
export { createEmptyGameState, getPieceAt, restoreState, snapshotState } from './state.js';
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
  HistoryPieceSnapshot,
  GameStateSnapshot,
  Piece,
  PieceType,
  Position,
} from './types.js';
