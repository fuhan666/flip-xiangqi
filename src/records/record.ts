import { snapshotState, restoreState, PIECE_SYMBOLS } from '../game';
import type { Camp, GameState, GameStateSnapshot, GameHistoryEntry, HistoryPieceSnapshot, Position } from '../game';
import { parseGameStateSnapshot } from '../network/match';
import type { EndgameReason } from '../network/match-clock';

export interface GameRecord {
  format: 'flip-xiangqi';
  schemaVersion: 1;
  opening: { mode: 'local' | 'online'; seats: { red: string; black: string }; seed?: number };
  initial: GameStateSnapshot;
  moves: GameHistoryEntry[];
  result: { winner: Camp | null; reason: EndgameReason; totalSteps: number; durationSeconds: number; timeBasis: 'elapsed' | 'player-clocks' };
  final: GameStateSnapshot;
}

export const reasonLabels: Record<EndgameReason, string> = {
  checkmate: '将死', 'king-captured': '将/帅被吃', resignation: '认输',
  'draw-agreement': '双方和棋', 'match-timeout': '局时超时',
  'step-timeout': '单步超时', 'disconnect-timeout': '掉线超时',
};
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const samePosition = (a: Position | null, b: Position | null) => a?.x === b?.x && a?.y === b?.y;
function ensure(condition: unknown): asserts condition {
  if (!condition) throw new Error('棋谱字段或对局序列不一致');
}
function identity(piece: HistoryPieceSnapshot, expected: HistoryPieceSnapshot) {
  ensure(piece && piece.id === expected.id && piece.camp === expected.camp && piece.type === expected.type && samePosition(piece.position, expected.position));
}

// Projection only: replay never submits actions to the rules engine.
function advance(state: GameStateSnapshot, entry: GameHistoryEntry): void {
  ensure(!state.winner && entry.actor === state.currentTurn);
  ensure(entry.stepNumber === state.actionHistory.length + 1 && entry.turnNumber === entry.stepNumber);
  const action = entry.action;
  const piece = state.pieces.find((p) => p.id === action.piece?.id);
  ensure(piece && !piece.captured);
  identity(action.piece, piece);
  const captures = entry.consequences.filter((c) => c.type === 'capture');
  ensure(captures.length <= 1);
  if (action.type === 'flip') {
    ensure(entry.kind === 'flip' && !piece.revealed && samePosition(piece.position, action.position) && captures.length === 0);
    if (action.from) ensure(samePosition(action.from, action.position));
    if (action.to) ensure(samePosition(action.to, action.position));
    piece.revealed = true;
  } else {
    ensure(piece.revealed && piece.camp === entry.actor && samePosition(piece.position, action.from) && !samePosition(action.from, action.to));
    const target = state.pieces.find((p) => !p.captured && samePosition(p.position, action.to));
    ensure(entry.kind === (target ? 'capture' : 'move') && captures.length === (target ? 1 : 0));
    if (target) {
      ensure(target.camp !== piece.camp);
      identity(captures[0].piece, target);
      ensure(samePosition(captures[0].position, action.to));
      target.captured = true;
      target.position = null;
    }
    piece.position = { ...action.to };
  }
  const checks = entry.consequences.filter((c) => c.type === 'check');
  const ends = entry.consequences.filter((c) => c.type === 'endgame');
  ensure(entry.consequences.length === captures.length + checks.length + ends.length);
  ensure(checks.length <= 1 && ends.length <= 1);
  ensure((checks[0]?.camp ?? null) === entry.checkedCamp);
  ensure((ends[0]?.winner ?? null) === entry.winner);
  if (ends[0]) ensure(ends[0].winner === entry.actor && ['checkmate', 'king-captured'].includes(ends[0].reason));
  const next = entry.actor === 'red' ? 'black' : 'red';
  ensure(entry.nextTurn === (entry.winner ? null : next));
  state.currentTurn = next;
  state.winner = entry.winner;
  state.checkedCamp = entry.checkedCamp;
  state.statusMessage = entry.statusMessage;
  state.lastError = null;
  state.actionHistory.push(copy(entry));
  state.recentAction = copy(entry);
}

export function replayFrame(record: GameRecord, step: number): GameState {
  const count = Math.max(0, Math.min(record.moves.length, Math.trunc(step)));
  const state = copy(record.initial);
  for (const move of record.moves.slice(0, count)) advance(state, move);
  if (count === record.moves.length) return restoreState(record.final, []);
  return restoreState(state, []);
}

export function createRecord(initial: GameStateSnapshot, final: GameStateSnapshot, opening: GameRecord['opening'], result: Omit<GameRecord['result'], 'totalSteps'>): GameRecord {
  const cleanInitial = snapshotState(restoreState(initial, []));
  const cleanFinal = snapshotState(restoreState(final, []));
  cleanInitial.lastError = cleanFinal.lastError = null;
  return copy({ format: 'flip-xiangqi', schemaVersion: 1, opening, initial: cleanInitial,
    moves: cleanFinal.actionHistory, result: { ...result, totalSteps: cleanFinal.actionHistory.length }, final: cleanFinal });
}

export function parseRecord(text: string): GameRecord {
  ensure(text.length <= 10_000_000);
  const raw = JSON.parse(text) as GameRecord;
  ensure(raw && raw.format === 'flip-xiangqi' && raw.schemaVersion === 1);
  ensure(raw.opening && ['local', 'online'].includes(raw.opening.mode));
  ensure(typeof raw.opening.seats?.red === 'string' && typeof raw.opening.seats?.black === 'string');
  ensure(raw.opening.seed === undefined || (Number.isSafeInteger(raw.opening.seed) && raw.opening.seed >= 0));
  const initial = parseGameStateSnapshot(raw.initial);
  const final = parseGameStateSnapshot(raw.final);
  ensure(initial && final && Array.isArray(raw.moves) && raw.moves.length <= 20000);
  ensure(initial.actionHistory.length === 0 && !initial.recentAction && !initial.winner);
  for (const frame of [initial, final]) {
    ensure(frame.pieces.length > 0 && frame.pieces.length <= 32 && new Set(frame.pieces.map((p) => p.id)).size === frame.pieces.length);
  }
  const r = raw.result;
  ensure(r && Object.hasOwn(reasonLabels, r.reason) && (r.winner === null || r.winner === 'red' || r.winner === 'black'));
  ensure((r.reason === 'draw-agreement') === (r.winner === null));
  ensure(r.totalSteps === raw.moves.length && Number.isFinite(r.durationSeconds) && r.durationSeconds >= 0);
  ensure(r.timeBasis === (raw.opening.mode === 'local' ? 'elapsed' : 'player-clocks'));
  ensure(JSON.stringify(raw.moves) === JSON.stringify(raw.final.actionHistory));
  // Parse entry fields and coordinates using the shared wire field validator.
  const parsedHistory = parseGameStateSnapshot({ ...raw.final, actionHistory: raw.moves });
  ensure(parsedHistory);
  const projected = copy(initial);
  for (const move of parsedHistory.actionHistory) advance(projected, move);
  ensure(JSON.stringify(projected.pieces) === JSON.stringify(final.pieces));
  ensure(projected.currentTurn === final.currentTurn && projected.checkedCamp === final.checkedCamp);
  ensure(final.winner === r.winner);
  const end = projected.recentAction?.consequences.find((c) => c.type === 'endgame');
  if (r.reason === 'checkmate' || r.reason === 'king-captured') ensure(end?.reason === r.reason && projected.winner === r.winner);
  else ensure(!projected.winner);
  ensure(JSON.stringify(final.recentAction) === JSON.stringify(projected.recentAction));
  return createRecord(initial, final, raw.opening, r);
}

const pos = (p: Position) => `(${p.x + 1},${p.y + 1})`;
const label = (p: HistoryPieceSnapshot) => `${p.camp === 'red' ? '红' : '黑'}${PIECE_SYMBOLS[p.camp][p.type]}`;
export function moveText(move: GameHistoryEntry): string {
  const a = move.action;
  const capture = move.consequences.find((c) => c.type === 'capture');
  return `${move.stepNumber}. ${move.actor === 'red' ? '红方' : '黑方'} ${a.type === 'flip' ? `翻开${label(a.piece)} ${pos(a.position)}` : `${label(a.piece)} ${pos(a.from)} → ${pos(a.to)}`}${capture ? ` 吃${label(capture.piece)}` : ''}${move.checkedCamp ? ' 将军' : ''}；耗时 ${move.durationSeconds === null ? '未知' : `${move.durationSeconds} 秒`}`;
}
export function recordText(record: GameRecord): string {
  const r = record.result;
  return ['翻牌中国象棋 · 完整棋谱', `红方：${record.opening.seats.red}；黑方：${record.opening.seats.black}`,
    ...(record.opening.seed === undefined ? [] : [`开局种子：${record.opening.seed}`]),
    '坐标：(列,行)，从左上角起均从 1 开始，与显示视角无关。',
    ...record.moves.map(moveText), `结果：${r.winner ? (r.winner === 'red' ? '红方获胜' : '黑方获胜') : '平局'}；${reasonLabels[r.reason]}`,
    `总步数：${r.totalSteps}；总时长：${r.durationSeconds} 秒（${r.timeBasis === 'elapsed' ? '开局至终局经过时间，含已撤销动作' : '双方权威用时之和'}）`,
    'JSON 文件包含完整初始布局，可用于单步复盘。'].join('\n');
}
export function recordJSON(record: GameRecord): string { return JSON.stringify(record, null, 2); }
export function downloadRecord(record: GameRecord, format: 'txt' | 'json'): void {
  const blob = new Blob([format === 'txt' ? recordText(record) : recordJSON(record)], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `flip-xiangqi-${record.result.totalSteps}-steps.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let the browser acquire the download before releasing the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
