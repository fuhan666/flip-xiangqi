import { BLACK_KING_POSITION, NON_KING_PIECES, RED_KING_POSITION } from './constants.js';
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
  RuleState,
  UndoEntry,
} from './types.js';

function clonePosition(position: Position | null): Position | null {
  return position ? { ...position } : null;
}

function clonePiece(piece: Piece): Piece {
  return {
    ...piece,
    position: clonePosition(piece.position),
  };
}

/** 复制棋子数组（局面数据）；历史、撤销与开局快照不在此复制。 */
export function clonePieces(pieces: Piece[]): Piece[] {
  return pieces.map(clonePiece);
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
      from: { ...(action.from ?? action.position) },
      to: { ...(action.to ?? action.position) },
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
    stepNumber: entry.stepNumber ?? entry.turnNumber,
    turnNumber: entry.turnNumber,
    kind: entry.kind ?? (entry.action.type === 'flip' ? 'flip' : entry.consequences.some((c) => c.type === 'capture') ? 'capture' : 'move'),
    durationSeconds: entry.durationSeconds ?? null,
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
    pieces: clonePieces(snapshot.pieces),
    actionHistory: snapshot.actionHistory.map(cloneHistoryEntry),
    recentAction: snapshot.recentAction ? cloneHistoryEntry(snapshot.recentAction) : null,
  };
}

export function snapshotState(state: GameState): GameStateSnapshot {
  return cloneStateSnapshot(state);
}

/**
 * 从可传输/复盘快照恢复权威游戏状态。
 * 撤销记录视为不可变数据：只复制数组本身，不复制单条记录。
 */
export function restoreState(snapshot: GameStateSnapshot, undoStack: UndoEntry[] = []): GameState {
  return {
    ...cloneStateSnapshot(snapshot),
    undoStack: [...undoStack],
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

/**
 * 复制权威游戏状态的可变容器：棋子逐枚复制；
 * 历史条目与撤销记录创建后不可变，按引用共享，不再整段深拷贝。
 */
export function cloneState(state: GameState): GameState {
  return {
    ...state,
    pieces: clonePieces(state.pieces),
    actionHistory: [...state.actionHistory],
    undoStack: [...state.undoStack],
  };
}

export function positionsEqual(left: Position, right: Position): boolean {
  return left.x === right.x && left.y === right.y;
}

export function getPieceAt(state: RuleState, position: Position): Piece | undefined {
  return state.pieces.find((piece) => !piece.captured && piece.position && positionsEqual(piece.position, position));
}

export function findKing(state: RuleState, camp: Camp): Piece | undefined {
  return state.pieces.find((piece) => piece.type === 'king' && piece.camp === camp && !piece.captured);
}

export function otherCamp(camp: Camp): Camp {
  return camp === 'red' ? 'black' : 'red';
}
