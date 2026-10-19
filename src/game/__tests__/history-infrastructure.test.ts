import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createInitialGameState,
} from '../index';
import { MatchClock } from '../../network/match-clock';
import { applyMatchAction, createMatch } from '../../network/match';
import { buildStartParameters } from '../../network/lobby';

describe('Move record infrastructure (v0.8.0 replay groundwork)', () => {
  it('assigns stepNumber starting at 1 and tags kind as flip', () => {
    const state0 = createInitialGameState();
    const darkPiecePos = state0.pieces.find((p) => !p.revealed)!.position!;

    const state1 = applyAction(state0, { type: 'flip', position: darkPiecePos }, { durationSeconds: 3 });

    expect(state1.actionHistory).toHaveLength(1);
    const entry = state1.actionHistory[0];
    expect(entry.stepNumber).toBe(1);
    expect(entry.kind).toBe('flip');
    expect(entry.durationSeconds).toBe(3);
    expect(entry.action.type).toBe('flip');
    if (entry.action.type === 'flip') {
      expect(entry.action.from).toEqual(darkPiecePos);
      expect(entry.action.to).toEqual(darkPiecePos);
      expect(entry.action.piece.id).toBeDefined();
    }
  });

  it('tags kind as move or capture depending on whether a piece was captured', () => {
    const state0 = createInitialGameState();
    const redKing = state0.pieces.find((p) => p.type === 'king' && p.camp === 'red')!;
    const fromPos = redKing.position!;
    const toPos = { x: fromPos.x, y: fromPos.y - 1 };

    // 移动到空格
    const state1 = applyAction(state0, { type: 'move', from: fromPos, to: toPos }, { durationSeconds: 2 });
    expect(state1.actionHistory).toHaveLength(1);
    expect(state1.actionHistory[0].stepNumber).toBe(1);
    expect(state1.actionHistory[0].kind).toBe('move');
    expect(state1.actionHistory[0].durationSeconds).toBe(2);
  });

  it('tracks current step duration in MatchClock and injects into applyMatchAction', () => {
    let now = 100_000;
    const startParameters = buildStartParameters({
      roomId: 'r1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });

    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    // 思考 5.4 秒后执行操作
    now += 5400;
    clock.advance(now);
    expect(clock.getCurrentStepDurationSeconds()).toBe(5);

    const match = createMatch({
      matchId: 'm-1',
      seed: 42,
      startParameters,
      nowFn: () => now,
      initialTime: now,
    });
    // 使用同一个 clock 实例以测试时钟耗时注入
    match.clock = clock;

    const darkPos = match.gameState.pieces.find((p) => !p.revealed)!.position!;
    const res = applyMatchAction(
      match,
      match.startParameters.redMemberId,
      { type: 'flip', position: darkPos },
      now,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.match.stepNumber).toBe(1);
    const lastEntry = res.match.gameState.actionHistory[0];
    expect(lastEntry.stepNumber).toBe(1);
    expect(lastEntry.durationSeconds).toBe(5);
  });

  it('maintains independent matchEvents sequence on match state', () => {
    let now = 1000;
    const startParameters = buildStartParameters({
      roomId: 'r2',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });

    const match = createMatch({
      matchId: 'm-2',
      seed: 42,
      startParameters,
      nowFn: () => now,
      initialTime: now,
    });

    expect(match.matchEvents).toEqual([]);
    match.matchEvents.push({
      id: 'evt-1',
      type: 'undo-request',
      actorMemberId: 'host-1',
      stepNumber: 0,
      revision: 0,
      result: 'pending',
      createdAt: now,
      message: '发起悔棋协商',
    });

    expect(match.matchEvents).toHaveLength(1);
    expect(match.gameState.actionHistory).toHaveLength(0); // 协商不污染着法历史
  });
});
