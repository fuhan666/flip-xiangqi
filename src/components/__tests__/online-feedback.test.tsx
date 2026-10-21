import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameViewState, PieceView } from '../../game/types';
import type { AcceptedGameAction } from '../../network/client';
import { useOnlineBoardFeedback } from '../useOnlineBoardFeedback';

function viewState(pieces: PieceView[], overrides: Partial<GameViewState> = {}): GameViewState {
  return {
    pieces,
    currentTurn: 'black',
    winner: null,
    checkedCamp: null,
    lastError: null,
    statusMessage: '',
    actionHistory: [],
    recentAction: null,
    legalMoves: [],
    ...overrides,
  };
}

const hidden: PieceView = { id: 't7', position: { x: 3, y: 4 }, revealed: false };
const revealed: PieceView = { id: 't7', position: { x: 3, y: 4 }, revealed: true, camp: 'black', type: 'rook', captured: false };

const flipEntry = {
  stepNumber: 1,
  turnNumber: 1,
  kind: 'flip' as const,
  actor: 'red' as const,
  action: { type: 'flip' as const, position: { x: 3, y: 4 }, piece: { id: 't7', camp: 'black' as const, type: 'rook' as const, position: { x: 3, y: 4 } } },
  consequences: [],
  nextTurn: 'black' as const,
  checkedCamp: null,
  winner: null,
  statusMessage: '',
  durationSeconds: 1,
};

function confirmed(revision: number): AcceptedGameAction {
  return {
    eventId: `m1:${revision}:host`,
    stepNumber: 1,
    actorMemberId: 'host',
    action: { type: 'flip', position: { x: 3, y: 4 } },
    source: 'remote',
    confirmed: true,
  };
}

describe('联机翻牌反馈只使用公开数据', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('翻牌动画的翻前帧不泄露刚翻出棋子的阵营/棋种', () => {
    vi.useFakeTimers();
    const state = viewState([hidden, revealed], { actionHistory: [flipEntry], recentAction: flipEntry });
    const { result } = renderHook(() => useOnlineBoardFeedback(state, confirmed(2)));

    expect(result.current.flip?.phase).toBe('back');
    const animated = result.current.displayState.pieces.find((piece) => piece.id === 't7')!;
    expect(animated.revealed).toBe(false);
    expect(Object.keys(animated).sort()).toEqual(['id', 'position', 'revealed']);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.flip?.phase).toBe('front');
  });

  it('未确认的本地动作不播放动画；同一次确认重复到达也不重播', () => {
    vi.useFakeTimers();
    const state = viewState([hidden, revealed], { actionHistory: [flipEntry], recentAction: flipEntry });
    const unconfirmed: AcceptedGameAction = { ...confirmed(2), confirmed: false };

    const { result, rerender } = renderHook(
      ({ action }: { action: AcceptedGameAction | null }) => useOnlineBoardFeedback(state, action),
      { initialProps: { action: unconfirmed } },
    );
    expect(result.current.flip).toBeNull();

    rerender({ action: confirmed(2) });
    expect(result.current.flip).not.toBeNull();

    rerender({ action: { ...confirmed(2) } });
    expect(result.current.flip?.phase).toBe('back');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // 同 revision 的重复确认不重新触发动画
    rerender({ action: { ...confirmed(2) } });
    expect(result.current.flip).toBeNull();
  });
});
