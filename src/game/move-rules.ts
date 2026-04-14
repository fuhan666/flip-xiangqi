import { BOARD_HEIGHT, BOARD_WIDTH } from './constants';
import { cloneState, findKing, getPieceAt, otherCamp } from './state';
import type { Camp, GameState, MoveValidationResult, Piece, Position } from './types';

function isInsideBoard(position: Position): boolean {
  return position.x >= 0 && position.x < BOARD_WIDTH && position.y >= 0 && position.y < BOARD_HEIGHT;
}

function isInPalace(camp: Camp, position: Position): boolean {
  const palaceRows = camp === 'red' ? [7, 8, 9] : [0, 1, 2];
  return position.x >= 3 && position.x <= 5 && palaceRows.includes(position.y);
}

function hasCrossedRiver(camp: Camp, position: Position): boolean {
  return camp === 'red' ? position.y <= 4 : position.y >= 5;
}

function pathClear(state: GameState, from: Position, to: Position): { clear: boolean; blockers: Piece[] } {
  const blockers: Piece[] = [];
  const deltaX = Math.sign(to.x - from.x);
  const deltaY = Math.sign(to.y - from.y);
  let cursor = { x: from.x + deltaX, y: from.y + deltaY };

  while (cursor.x !== to.x || cursor.y !== to.y) {
    const blocker = getPieceAt(state, cursor);
    if (blocker) {
      blockers.push(blocker);
    }
    cursor = { x: cursor.x + deltaX, y: cursor.y + deltaY };
  }

  return { clear: blockers.length === 0, blockers };
}

function validateBasicMove(state: GameState, piece: Piece, to: Position): MoveValidationResult {
  if (!piece.position) {
    return { ok: false, reason: '棋子不在棋盘上' };
  }

  if (!isInsideBoard(to)) {
    return { ok: false, reason: '目标超出棋盘范围' };
  }

  if (piece.position.x === to.x && piece.position.y === to.y) {
    return { ok: false, reason: '必须移动到其他格位' };
  }

  const target = getPieceAt(state, to);
  if (target?.camp === piece.camp) {
    return { ok: false, reason: '不能吃己方棋子' };
  }

  if (target && !target.revealed) {
    return { ok: false, reason: '暗子不能被直接吃掉' };
  }

  const dx = to.x - piece.position.x;
  const dy = to.y - piece.position.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  switch (piece.type) {
    case 'rook': {
      if (dx !== 0 && dy !== 0) {
        return { ok: false, reason: '车只能直走' };
      }
      return pathClear(state, piece.position, to).clear ? { ok: true } : { ok: false, reason: '路径被阻挡' };
    }
    case 'cannon': {
      if (dx !== 0 && dy !== 0) {
        return { ok: false, reason: '炮只能直走' };
      }
      const { blockers } = pathClear(state, piece.position, to);
      if (target) {
        if (blockers.length !== 1) {
          return { ok: false, reason: '炮吃子时必须隔一个架子' };
        }
        return { ok: true };
      }
      return blockers.length === 0 ? { ok: true } : { ok: false, reason: '炮平移时路径必须畅通' };
    }
    case 'horse': {
      if (!((absX === 1 && absY === 2) || (absX === 2 && absY === 1))) {
        return { ok: false, reason: '马走日' };
      }
      const leg = absX === 2
        ? { x: piece.position.x + Math.sign(dx), y: piece.position.y }
        : { x: piece.position.x, y: piece.position.y + Math.sign(dy) };
      return getPieceAt(state, leg) ? { ok: false, reason: '马腿被阻挡' } : { ok: true };
    }
    case 'elephant': {
      if (!(absX === 2 && absY === 2)) {
        return { ok: false, reason: '相/象走田' };
      }
      if ((piece.camp === 'red' && to.y < 5) || (piece.camp === 'black' && to.y > 4)) {
        return { ok: false, reason: '相/象不能过河' };
      }
      const eye = { x: piece.position.x + dx / 2, y: piece.position.y + dy / 2 };
      return getPieceAt(state, eye) ? { ok: false, reason: '象眼被堵住' } : { ok: true };
    }
    case 'advisor': {
      if (!(absX === 1 && absY === 1)) {
        return { ok: false, reason: '士/仕走斜一步' };
      }
      return isInPalace(piece.camp, to) ? { ok: true } : { ok: false, reason: '士/仕不能离开九宫' };
    }
    case 'king': {
      const facingMove = dx === 0 && target?.type === 'king';
      if (facingMove) {
        return pathClear(state, piece.position, to).clear ? { ok: true } : { ok: false, reason: '将/帅不能隔子直吃' };
      }
      if (!((absX === 1 && absY === 0) || (absX === 0 && absY === 1))) {
        return { ok: false, reason: '将/帅只能走一步直线' };
      }
      return isInPalace(piece.camp, to) ? { ok: true } : { ok: false, reason: '将/帅不能离开九宫' };
    }
    case 'pawn': {
      const forward = piece.camp === 'red' ? -1 : 1;
      if (dy === forward && dx === 0) {
        return { ok: true };
      }
      if (hasCrossedRiver(piece.camp, piece.position) && dy === 0 && absX === 1) {
        return { ok: true };
      }
      return { ok: false, reason: '兵/卒不能这样移动' };
    }
    default:
      return { ok: false, reason: '未知棋种' };
  }
}

function canAttackSquare(state: GameState, attacker: Piece, target: Position): boolean {
  if (!attacker.position || attacker.captured || !attacker.revealed) {
    return false;
  }

  if (attacker.type === 'pawn') {
    const dx = target.x - attacker.position.x;
    const dy = target.y - attacker.position.y;
    const forward = attacker.camp === 'red' ? -1 : 1;
    if (dy === forward && dx === 0) {
      return true;
    }
    return hasCrossedRiver(attacker.camp, attacker.position) && dy === 0 && Math.abs(dx) === 1;
  }

  if (attacker.type === 'king') {
    if (target.x === attacker.position.x) {
      const targetPiece = getPieceAt(state, target);
      if (targetPiece?.type === 'king') {
        return pathClear(state, attacker.position, target).clear;
      }
    }
  }

  const result = validateBasicMove(state, attacker, target);
  return result.ok;
}

export function isInCheck(state: GameState, camp: Camp): boolean {
  const king = findKing(state, camp);
  if (!king?.position) {
    return false;
  }

  return state.pieces.some((piece) => piece.camp === otherCamp(camp) && canAttackSquare(state, piece, king.position!));
}

export function violatesFacingKings(state: GameState): boolean {
  const redKing = findKing(state, 'red');
  const blackKing = findKing(state, 'black');
  if (!redKing?.position || !blackKing?.position || redKing.position.x !== blackKing.position.x) {
    return false;
  }
  return pathClear(state, redKing.position, blackKing.position).clear;
}

function simulateMove(state: GameState, piece: Piece, to: Position): GameState {
  const next = cloneState(state);
  const movingPiece = next.pieces.find((candidate) => candidate.id === piece.id)!;
  const target = next.pieces.find(
    (candidate) => !candidate.captured && candidate.position && candidate.position.x === to.x && candidate.position.y === to.y,
  );

  if (target) {
    target.captured = true;
    target.position = null;
  }

  movingPiece.position = { ...to };
  return next;
}

export function validateMove(state: GameState, piece: Piece, to: Position): MoveValidationResult {
  if (piece.captured || !piece.position) {
    return { ok: false, reason: '棋子已不在场上' };
  }
  if (!piece.revealed) {
    return { ok: false, reason: '只能移动已经翻开的明子' };
  }
  if (piece.camp !== state.currentTurn) {
    return { ok: false, reason: '当前不是该棋子的行动回合' };
  }

  const result = validateBasicMove(state, piece, to);
  if (!result.ok) {
    return result;
  }

  const simulated = simulateMove(state, piece, to);
  if (violatesFacingKings(simulated)) {
    return { ok: false, reason: '将/帅不能直接照面' };
  }
  if (isInCheck(simulated, piece.camp)) {
    return { ok: false, reason: '该着法会让己方将/帅继续处于将军状态' };
  }

  return { ok: true };
}

export function listLegalMoves(state: GameState, pieceId: string): Position[] {
  const piece = state.pieces.find((candidate) => candidate.id === pieceId);
  if (!piece?.position) {
    return [];
  }

  const legalMoves: Position[] = [];
  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const target = { x, y };
      if (validateMove(state, piece, target).ok) {
        legalMoves.push(target);
      }
    }
  }
  return legalMoves;
}

export function hasAnyLegalAction(state: GameState, camp: Camp): boolean {
  for (const piece of state.pieces) {
    if (piece.camp === camp && piece.revealed && !piece.captured && listLegalMoves({ ...state, currentTurn: camp }, piece.id).length > 0) {
      return true;
    }
  }

  for (const piece of state.pieces) {
    if (piece.position && !piece.revealed && !piece.captured) {
      const simulated = cloneState(state);
      const target = simulated.pieces.find((candidate) => candidate.id === piece.id)!;
      target.revealed = true;
      if (!violatesFacingKings(simulated) && !isInCheck(simulated, camp)) {
        return true;
      }
    }
  }

  return false;
}
