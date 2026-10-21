import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createInitialGameState,
  hasAnyLegalAction,
  isInCheck,
  listLegalMoves,
  snapshotState,
  undoLastAction,
} from '../index';
import type { GameAction, GameState } from '../types';

/** 32 枚全部明置的标准开局：无将帅照面，双方马在(1,9)/(1,0)可四步往返。 */
function revealedBoard(): GameState {
  const pieces: GameState['pieces'] = [];
  const add = (camp: 'red' | 'black', type: GameState['pieces'][number]['type'], x: number, y: number) => {
    pieces.push({ id: `${camp}-${type}-${x}-${y}`, camp, type, position: { x, y }, revealed: true, captured: false });
  };
  for (const camp of ['black', 'red'] as const) {
    const back = camp === 'black' ? 0 : 9;
    const pawn = camp === 'black' ? 3 : 6;
    const cannon = camp === 'black' ? 2 : 7;
    add(camp, 'king', 4, back);
    add(camp, 'advisor', 3, back);
    add(camp, 'advisor', 5, back);
    add(camp, 'elephant', 2, back);
    add(camp, 'elephant', 6, back);
    add(camp, 'horse', 1, back);
    add(camp, 'horse', 7, back);
    add(camp, 'rook', 0, back);
    add(camp, 'rook', 8, back);
    add(camp, 'cannon', 1, cannon);
    add(camp, 'cannon', 7, cannon);
    for (const x of [0, 2, 4, 6, 8]) add(camp, 'pawn', x, pawn);
  }
  const state = createInitialGameState(() => 0);
  return { ...state, pieces };
}

const cycle: GameAction[] = [
  { type: 'move', from: { x: 1, y: 9 }, to: { x: 2, y: 7 } },
  { type: 'move', from: { x: 1, y: 0 }, to: { x: 2, y: 2 } },
  { type: 'move', from: { x: 2, y: 7 }, to: { x: 1, y: 9 } },
  { type: 'move', from: { x: 2, y: 2 }, to: { x: 1, y: 0 } },
];

function play(state: GameState, steps: number): GameState {
  let next = state;
  for (let i = 0; i < steps; i += 1) {
    next = applyAction(next, cycle[i % cycle.length]);
    expect(next.lastError).toBeNull();
  }
  return next;
}

describe('compact history and undo storage', () => {
  it('stores one authoritative history and constant-size undo entries instead of nested snapshots', () => {
    const state = play(revealedBoard(), 400);

    expect(state.actionHistory).toHaveLength(400);
    expect(state.undoStack).toHaveLength(400);
    for (const entry of state.undoStack) {
      expect(Object.keys(entry).sort()).toEqual([
        'checkedCamp',
        'currentTurn',
        'historyLength',
        'lastError',
        'pieces',
        'statusMessage',
        'winner',
      ]);
      expect(entry.pieces.length).toBeLessThanOrEqual(2);
    }

    const at200 = play(revealedBoard(), 200);
    const at400 = state;
    const bytes200 = JSON.stringify(at200).length;
    const bytes400 = JSON.stringify(at400).length;
    // 早期实现每步嵌入完整快照，200→400 步接近 4 倍；紧凑结构约线性。
    expect(bytes400 / bytes200).toBeLessThan(2.6);
  });

  it('restores board, turn, check state, history and recentAction through repeated undo', () => {
    const frames: GameState[] = [];
    let state = revealedBoard();
    frames.push(state);
    for (let i = 0; i < 30; i += 1) {
      state = applyAction(state, cycle[i % cycle.length]);
      expect(state.lastError).toBeNull();
      frames.push(state);
    }

    let current = state;
    for (let step = 30; step > 0; step -= 1) {
      current = undoLastAction(current);
      const expected = frames[step - 1];
      expect(snapshotState(current)).toEqual(snapshotState(expected));
      expect(current.currentTurn).toBe(expected.currentTurn);
      expect(current.checkedCamp).toBe(expected.checkedCamp);
      expect(current.winner).toBe(expected.winner);
      expect(current.statusMessage).toBe(expected.statusMessage);
      expect(current.lastError).toBe(expected.lastError);
      expect(current.actionHistory).toHaveLength(step - 1);
      expect(current.recentAction?.stepNumber ?? null).toBe(step - 1 === 0 ? null : step - 1);
      expect(current.undoStack).toHaveLength(step - 1);
    }
  });

  it('discards undone steps when the main line forks and never writes them to history', () => {
    const opening = snapshotState(revealedBoard());
    const progressed = play(revealedBoard(), 8);
    let forked = progressed;
    for (let i = 0; i < 3; i += 1) forked = undoLastAction(forked);

    const forkMove: GameAction = forked.currentTurn === 'red'
      ? { type: 'move', from: { x: 1, y: 9 }, to: { x: 0, y: 7 } }
      : { type: 'move', from: { x: 1, y: 0 }, to: { x: 0, y: 2 } };
    const branch = applyAction(forked, forkMove);
    expect(branch.lastError).toBeNull();
    expect(branch.actionHistory).toHaveLength(6);
    expect(branch.actionHistory[5].stepNumber).toBe(6);
    expect(branch.recentAction?.stepNumber).toBe(6);
    expect(branch.undoStack).toHaveLength(6);
    // 新主线不携带被撤销的步骤，且开局仍是最初的空历史帧。
    expect(opening.actionHistory).toHaveLength(0);
    const lastStep = branch.actionHistory[branch.actionHistory.length - 1];
    expect(lastStep.action.type).toBe('move');
    if (lastStep.action.type === 'move') {
      expect(lastStep.action.from).toEqual(forkMove.from);
    }
  });

  it('computes legal moves, checks and endgame without reading history or undo data', () => {
    const state = play(revealedBoard(), 40);
    const bogusHistory = Array.from({ length: 5000 }, () => ({
      stepNumber: 1,
      turnNumber: 1,
      kind: 'flip',
      actor: 'red',
      action: { type: 'flip', position: { x: 0, y: 0 } },
      consequences: [],
      nextTurn: 'black',
      checkedCamp: null,
      winner: null,
      statusMessage: '红方翻开',
      durationSeconds: null,
    })) as unknown as GameState['actionHistory'];
    const noisy: GameState = {
      ...state,
      actionHistory: bogusHistory,
      recentAction: bogusHistory[0],
      undoStack: new Array(5000).fill(state.undoStack[0]),
    };

    const piecesBefore = JSON.stringify(state.pieces);
    for (const piece of state.pieces) {
      expect(listLegalMoves(noisy, piece.id)).toEqual(listLegalMoves(state, piece.id));
    }
    expect(isInCheck(noisy, 'red')).toBe(isInCheck(state, 'red'));
    expect(isInCheck(noisy, 'black')).toBe(isInCheck(state, 'black'));
    expect(hasAnyLegalAction(noisy, state.currentTurn)).toBe(hasAnyLegalAction(state, state.currentTurn));
    // 规则模拟不能改写调用方局面。
    expect(JSON.stringify(state.pieces)).toBe(piecesBefore);
  });
});
