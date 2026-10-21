/**
 * 公开棋局投影：把服务端权威内部状态收敛成唯一可下发的公开形状。
 *
 * 规则：
 * - 手工按白名单构造公开对象，绝不展开内部快照后再删字段；
 * - 未翻开的棋子只输出位置与本局不透明标识；
 * - 历史/最近动作中的棋子 ID 统一映射为公开 ID；
 * - 落点提示由服务端基于权威局面计算，只暴露公开占位与明子；
 * - 投影无副作用，不修改内部棋子、历史、开局帧或撤销栈。
 */
import { getPieceAt, listLegalMoves } from '../src/game/index.js';
import type {
  GameHistoryAction,
  GameHistoryConsequence,
  GameHistoryEntry,
  LegalMoveGroup,
  Piece,
  Position,
} from '../src/game/index.js';
import type { MatchState } from '../src/network/match.js';
import type {
  PublicGameState,
  PublicMatchSnapshot,
  PublicPiece,
} from '../src/network/public-game.js';

function positionOrder(piece: { position: Position | null }): [number, number] {
  if (!piece.position) {
    return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  }
  return [piece.position.y, piece.position.x];
}

/**
 * 公开数组顺序：棋盘内棋子按公开坐标（先 y 后 x）排序，被吃明子按公开 ID 排在最后。
 * 该顺序只取决于公开信息，不携带内部棋子数组的身份顺序。
 */
function comparePublicPieces(left: PublicPiece, right: PublicPiece): number {
  const [leftY, leftX] = positionOrder(left);
  const [rightY, rightX] = positionOrder(right);
  if (leftY !== rightY) {
    return leftY - rightY;
  }
  if (leftX !== rightX) {
    return leftX - rightX;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function createIdMapper(match: MatchState): (internalId: string) => string {
  return (internalId: string) => {
    const publicId = match.publicPieceIds[internalId];
    if (!publicId) {
      throw new Error(`missing public piece id mapping for ${internalId}`);
    }
    return publicId;
  };
}

function projectPiece(piece: Piece, mapId: (internalId: string) => string): PublicPiece {
  if (!piece.revealed) {
    if (!piece.position) {
      throw new Error(`hidden piece without position: ${piece.id}`);
    }
    return { id: mapId(piece.id), position: { ...piece.position }, revealed: false };
  }
  return {
    id: mapId(piece.id),
    position: piece.position ? { ...piece.position } : null,
    revealed: true,
    camp: piece.camp,
    type: piece.type,
    captured: piece.captured,
  };
}

function projectHistoryAction(action: GameHistoryAction, mapId: (id: string) => string): GameHistoryAction {
  if (action.type === 'flip') {
    return {
      ...action,
      position: { ...action.position },
      ...(action.from ? { from: { ...action.from } } : {}),
      ...(action.to ? { to: { ...action.to } } : {}),
      piece: { ...action.piece, id: mapId(action.piece.id) },
    };
  }
  return {
    ...action,
    from: { ...action.from },
    to: { ...action.to },
    piece: { ...action.piece, id: mapId(action.piece.id) },
  };
}

function projectConsequence(
  consequence: GameHistoryConsequence,
  mapId: (id: string) => string,
): GameHistoryConsequence {
  if (consequence.type !== 'capture') {
    return consequence;
  }
  return {
    ...consequence,
    position: { ...consequence.position },
    piece: { ...consequence.piece, id: mapId(consequence.piece.id) },
  };
}

function projectHistoryEntry(entry: GameHistoryEntry, mapId: (id: string) => string): GameHistoryEntry {
  return {
    stepNumber: entry.stepNumber,
    turnNumber: entry.turnNumber,
    kind: entry.kind,
    actor: entry.actor,
    action: projectHistoryAction(entry.action, mapId),
    consequences: entry.consequences.map((consequence) => projectConsequence(consequence, mapId)),
    nextTurn: entry.nextTurn,
    checkedCamp: entry.checkedCamp,
    winner: entry.winner,
    statusMessage: entry.statusMessage,
    durationSeconds: entry.durationSeconds,
  };
}

/**
 * 当前行棋方明子的落点提示：只依据公开占位/明子判定 empty / capture，
 * 不给暗子的身份、试翻结果或能否翻开的预判。终局返回空列表。
 */
export function projectLegalMoves(match: MatchState): LegalMoveGroup[] {
  const mapId = createIdMapper(match);
  const state = match.gameState;
  if (state.winner !== null) {
    return [];
  }

  const groups: LegalMoveGroup[] = [];
  const ordered = state.pieces
    .filter((piece) => piece.revealed && !piece.captured && piece.position && piece.camp === state.currentTurn)
    .sort((left, right) => {
      const [leftY, leftX] = positionOrder(left);
      const [rightY, rightX] = positionOrder(right);
      return leftY !== rightY ? leftY - rightY : leftX - rightX;
    });

  for (const piece of ordered) {
    if (!piece.position) {
      continue;
    }
    const targets = listLegalMoves(state, piece.id).map((position) => ({
      position: { ...position },
      kind: getPieceAt(state, position) ? ('capture' as const) : ('empty' as const),
    }));
    if (targets.length === 0) {
      continue;
    }
    groups.push({
      pieceId: mapId(piece.id),
      from: { ...piece.position },
      targets,
    });
  }

  return groups;
}

/** 权威内部状态 → 公开局面（唯一允许下发给客户端的棋局形状）。 */
export function projectGameState(match: MatchState): PublicGameState {
  const mapId = createIdMapper(match);
  const state = match.gameState;
  const pieces = state.pieces.map((piece) => projectPiece(piece, mapId)).sort(comparePublicPieces);

  return {
    pieces,
    currentTurn: state.currentTurn,
    winner: state.winner,
    checkedCamp: state.checkedCamp,
    lastError: state.lastError,
    statusMessage: state.statusMessage,
    actionHistory: state.actionHistory.map((entry) => projectHistoryEntry(entry, mapId)),
    recentAction: state.recentAction ? projectHistoryEntry(state.recentAction, mapId) : null,
    legalMoves: projectLegalMoves(match),
  };
}

/** 权威内部对局 → 公开对局快照（welcome / 同步 / 广播共用同一投影）。 */
export function projectMatchSnapshot(match: MatchState, now?: number): PublicMatchSnapshot {
  return {
    matchId: match.matchId,
    stepNumber: match.stepNumber,
    revision: match.revision,
    startParameters: match.startParameters,
    gameState: projectGameState(match),
    clock: match.clock.getSnapshot(now),
    settlement: match.settlement ?? match.clock.getSettlement(),
    pendingNegotiation: match.pendingNegotiation,
    drawCooldownUntil: { ...match.drawCooldownUntil },
    phraseCooldownUntil: { ...match.phraseCooldownUntil },
    negotiationEvent: match.negotiationEvent,
    matchEvents: match.matchEvents.map((event) => ({ ...event })),
  };
}
