import { BLACK_KING_POSITION, NON_KING_PIECES, RED_KING_POSITION } from './constants';
import type {
  Camp,
  GameHistoryAction,
  GameHistoryConsequence,
  GameHistoryEntry,
  GameState,
  GameStateSnapshot,
  HistoryPieceSnapshot,
  Piece,
  Position,
} from './types';

function clonePosition(position: Position | null): Position | null {
  return position ? { ...position } : null;
}

function clonePiece(piece: Piece): Piece {
  return {
    ...piece,
    position: clonePosition(piece.position),
  };
}

function cloneHistoryPieceSnapshot(piece: HistoryPieceSnapshot): HistoryPieceSnapshot {
  return {
    ...piece,
    position: clonePosition(piece.position),
  };
}

function cloneHistoryAction(action: GameHistoryAction): GameHistoryAction {
  if (action.type === 'flip') {
    return {
      ...action,
      position: { ...action.position },
      piece: cloneHistoryPieceSnapshot(action.piece),
    };
  }

  return {
    ...action,
    from: { ...action.from },
    to: { ...action.to },
    piece: cloneHistoryPieceSnapshot(action.piece),
  };
}

function cloneHistoryConsequence(consequence: GameHistoryConsequence): GameHistoryConsequence {
  if (consequence.type === 'capture') {
    return {
      ...consequence,
      piece: cloneHistoryPieceSnapshot(consequence.piece),
      position: { ...consequence.position },
    };
  }

  return { ...consequence };
}

function cloneHistoryEntry(entry: GameHistoryEntry): GameHistoryEntry {
  return {
    ...entry,
    action: cloneHistoryAction(entry.action),
    consequences: entry.consequences.map(cloneHistoryConsequence),
  };
}

export function cloneStateSnapshot(snapshot: GameStateSnapshot): GameStateSnapshot {
  return {
    currentTurn: snapshot.currentTurn,
    winner: snapshot.winner,
    checkedCamp: snapshot.checkedCamp,
    lastError: snapshot.lastError,
    statusMessage: snapshot.statusMessage,
    pieces: snapshot.pieces.map(clonePiece),
    actionHistory: snapshot.actionHistory.map(cloneHistoryEntry),
    recentAction: snapshot.recentAction ? cloneHistoryEntry(snapshot.recentAction) : null,
  };
}

export function snapshotState(state: GameState): GameStateSnapshot {
  return cloneStateSnapshot(state);
}

export function restoreState(snapshot: GameStateSnapshot, undoStack: GameStateSnapshot[]): GameState {
  return {
    ...cloneStateSnapshot(snapshot),
    undoStack: undoStack.map(cloneStateSnapshot),
  };
}

export function createEmptyGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    pieces: [],
    currentTurn: 'red',
    winner: null,
    checkedCamp: null,
    lastError: null,
    statusMessage: '红方先行',
    actionHistory: [],
    recentAction: null,
    undoStack: [],
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
  return restoreState(snapshotState(state), state.undoStack);
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
