import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createEmptyGameState } from '../../game';
import type { Camp, GameHistoryEntry, GameState, HistoryPieceSnapshot, PieceType } from '../../game/types';
import type { AcceptedGameAction } from '../../network/client';
import type { MatchSettlement } from '../../network/protocol';
import type { AudioEngine, SoundName } from '../../audio';
import { useLocalGameAudio, useOnlineGameAudio } from '../useGameAudio';

const PAWN: HistoryPieceSnapshot = {
  id: 'red-pawn-1',
  camp: 'red',
  type: 'pawn' as PieceType,
  position: { x: 0, y: 0 },
};

function historyEntry(stepNumber: number, overrides: Partial<GameHistoryEntry> = {}): GameHistoryEntry {
  return {
    stepNumber,
    turnNumber: stepNumber,
    kind: 'move',
    actor: 'red' as Camp,
    action: {
      type: 'move',
      from: { x: 0, y: 6 },
      to: { x: 0, y: 5 },
      piece: PAWN,
    },
    consequences: [],
    nextTurn: 'black' as Camp,
    checkedCamp: null,
    winner: null,
    statusMessage: '',
    durationSeconds: 1,
    ...overrides,
  };
}

function flipEntry(stepNumber: number): GameHistoryEntry {
  return historyEntry(stepNumber, {
    kind: 'flip',
    action: { type: 'flip', position: { x: 3, y: 4 }, piece: PAWN },
  });
}

function captureEntry(stepNumber: number): GameHistoryEntry {
  return historyEntry(stepNumber, {
    kind: 'capture',
    consequences: [
      {
        type: 'capture',
        piece: { ...PAWN, id: 'black-pawn-1', camp: 'black' as Camp },
        position: { x: 0, y: 5 },
      },
    ],
  });
}

function winningEntry(stepNumber: number, winner: Camp = 'red' as Camp): GameHistoryEntry {
  return historyEntry(stepNumber, {
    winner,
    consequences: [
      { type: 'endgame', winner, reason: 'checkmate' },
      { type: 'check', camp: 'black' as Camp },
    ],
    checkedCamp: 'black' as Camp,
  });
}

function stateWith(entries: GameHistoryEntry[], overrides: Partial<GameState> = {}): GameState {
  return createEmptyGameState({
    actionHistory: entries,
    recentAction: entries.length > 0 ? entries[entries.length - 1] : null,
    ...overrides,
  });
}

function acceptedAction(overrides: Partial<AcceptedGameAction> = {}): AcceptedGameAction {
  return {
    eventId: 'match:1:req',
    stepNumber: 1,
    actorMemberId: 'member-red',
    action: { type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 5 } },
    source: 'remote',
    confirmed: true,
    ...overrides,
  };
}

function settlement(overrides: Partial<MatchSettlement> = {}): MatchSettlement {
  return {
    winner: 'red',
    loser: 'black',
    reason: 'resignation',
    redDurationSeconds: 30,
    blackDurationSeconds: 25,
    endedAt: 1,
    ...overrides,
  };
}

function createSpyEngine(): { engine: AudioEngine; calls: SoundName[][]; stopAllCount: () => number } {
  const calls: SoundName[][] = [];
  let stopAllCalls = 0;
  const engine: AudioEngine = {
    attach: () => () => undefined,
    unlock: () => undefined,
    play: (sound) => {
      calls.push([sound]);
    },
    playCues: (cues) => {
      calls.push([...cues]);
    },
    stopAll: () => {
      stopAllCalls += 1;
    },
    setVolume: () => undefined,
    setMuted: () => undefined,
    getState: () => ({ unlocked: true, contextState: 'running', activeVoices: 0 }),
  };
  return { engine, calls, stopAllCount: () => stopAllCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local game audio triggers', () => {
  it('plays only for newly appended history entries', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderHook(
      ({ state }: { state: GameState }) => useLocalGameAudio(state, engine),
      { initialProps: { state: stateWith([]) } },
    );

    expect(calls).toEqual([]);

    rerender({ state: stateWith([flipEntry(1)]) });
    expect(calls).toEqual([['flip']]);

    rerender({ state: stateWith([flipEntry(1), historyEntry(2)]) });
    expect(calls).toEqual([['flip'], ['move']]);
  });

  it('never replays history on mount', () => {
    const { engine, calls } = createSpyEngine();

    renderHook(({ state }: { state: GameState }) => useLocalGameAudio(state, engine), {
      initialProps: { state: stateWith([flipEntry(1), historyEntry(2), captureEntry(3)]) },
    });

    expect(calls).toEqual([]);
  });

  it('stays silent through undo and restart, but plays the next real action', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderHook(
      ({ state }: { state: GameState }) => useLocalGameAudio(state, engine),
      { initialProps: { state: stateWith([flipEntry(1), historyEntry(2)]) } },
    );

    rerender({ state: stateWith([flipEntry(1)]) }); // 悔棋
    rerender({ state: stateWith([]) }); // 重新开局
    expect(calls).toEqual([]);

    rerender({ state: stateWith([flipEntry(1)]) });
    expect(calls).toEqual([['flip']]);
  });

  it('plays the victory phrase exactly once for the winning move', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderHook(
      ({ state }: { state: GameState }) => useLocalGameAudio(state, engine),
      { initialProps: { state: stateWith([flipEntry(1)]) } },
    );

    rerender({ state: stateWith([flipEntry(1), winningEntry(2)]) });
    expect(calls).toEqual([['move', 'victory']]);

    // 同一局面重复渲染不重播；重开后的下一局终局仍会庆祝。
    rerender({ state: stateWith([flipEntry(1), winningEntry(2)]) });
    rerender({ state: stateWith([]) });
    rerender({ state: stateWith([winningEntry(1)]) });
    expect(calls).toEqual([
      ['move', 'victory'],
      ['move', 'victory'],
    ]);
  });

  it('plays the check cue when the game is still running', () => {
    const { engine, calls } = createSpyEngine();
    const checked = historyEntry(1, {
      consequences: [{ type: 'check', camp: 'black' as Camp }],
      checkedCamp: 'black' as Camp,
    });

    const { rerender } = renderHook(({ state }: { state: GameState }) => useLocalGameAudio(state, engine), {
      initialProps: { state: stateWith([]) },
    });

    rerender({ state: stateWith([checked]) });
    expect(calls).toEqual([['move', 'check']]);
  });

  it('ignores prefers-reduced-motion: sound is independent of animation settings', () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    );

    const { engine, calls } = createSpyEngine();
    const { rerender } = renderHook(({ state }: { state: GameState }) => useLocalGameAudio(state, engine), {
      initialProps: { state: stateWith([]) },
    });

    rerender({ state: stateWith([flipEntry(1)]) });
    expect(calls).toEqual([['flip']]);
  });

  it('does not double-play under StrictMode', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderHook(({ state }: { state: GameState }) => useLocalGameAudio(state, engine), {
      initialProps: { state: stateWith([]) },
      wrapper: React.StrictMode,
    });

    rerender({ state: stateWith([flipEntry(1)]) });
    expect(calls).toEqual([['flip']]);
  });

  it('cancels pending audio and detaches gestures on unmount', () => {
    const { engine, stopAllCount } = createSpyEngine();
    const { unmount } = renderHook(({ state }: { state: GameState }) => useLocalGameAudio(state, engine), {
      initialProps: { state: stateWith([]) },
    });

    unmount();
    expect(stopAllCount()).toBe(1);
  });
});

describe('online game audio triggers', () => {
  interface OnlineProps {
    gameState: GameState;
    action: AcceptedGameAction | null;
    end: MatchSettlement | null;
  }

  function renderOnline(engine: AudioEngine) {
    return renderHook((props: OnlineProps) => useOnlineGameAudio(props.gameState, props.action, props.end, engine), {
      initialProps: { gameState: stateWith([]), action: null, end: null } as OnlineProps,
    });
  }

  it('ignores the optimistic action and plays once on the authoritative confirmation', () => {
    const { engine, calls } = createSpyEngine();
    const state = stateWith([historyEntry(1)]);
    const { rerender } = renderOnline(engine);

    rerender({ gameState: state, action: acceptedAction({ confirmed: false }), end: null });
    expect(calls).toEqual([]);

    rerender({ gameState: state, action: acceptedAction({ confirmed: true }), end: null });
    expect(calls).toEqual([['move']]);

    // 同一动作的重复广播（eventId 不同）不会重播。
    rerender({
      gameState: state,
      action: acceptedAction({ confirmed: true, eventId: 'match:1:another-req' }),
      end: null,
    });
    expect(calls).toEqual([['move']]);
  });

  it('plays each remote action exactly once', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderOnline(engine);

    rerender({
      gameState: stateWith([flipEntry(1)]),
      action: acceptedAction({ stepNumber: 1, action: { type: 'flip', position: { x: 3, y: 4 } } }),
      end: null,
    });
    expect(calls).toEqual([['flip']]);

    rerender({
      gameState: stateWith([flipEntry(1), historyEntry(2)]),
      action: acceptedAction({ stepNumber: 2 }),
      end: null,
    });
    expect(calls).toEqual([['flip'], ['move']]);
  });

  it('never replays history when entering or recovering a match', () => {
    const { engine, calls } = createSpyEngine();

    renderHook((props: OnlineProps) => useOnlineGameAudio(props.gameState, props.action, props.end, engine), {
      initialProps: {
        gameState: stateWith([flipEntry(1), historyEntry(2), captureEntry(3)]),
        action: acceptedAction({ stepNumber: 3, confirmed: true }),
        end: null,
      } as OnlineProps,
    });

    expect(calls).toEqual([]);
  });

  it('does not sound a rejected action, and lets the retry play again', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderOnline(engine);

    rerender({ gameState: stateWith([historyEntry(1)]), action: acceptedAction({ confirmed: true }), end: null });
    expect(calls).toEqual([['move']]);

    // 服务端拒绝 -> 回滚到上一步并清空动作。
    rerender({ gameState: stateWith([]), action: null, end: null });
    expect(calls).toEqual([['move']]);

    // 同一动作重试并被接受。
    rerender({ gameState: stateWith([historyEntry(1)]), action: acceptedAction({ confirmed: true }), end: null });
    expect(calls).toEqual([['move'], ['move']]);
  });

  it('plays the victory phrase once for a no-move ending such as resignation', () => {
    const { engine, calls } = createSpyEngine();
    const state = stateWith([historyEntry(1)]);
    const { rerender } = renderOnline(engine);

    rerender({ gameState: state, action: acceptedAction({ stepNumber: 1 }), end: null });
    expect(calls).toEqual([['move']]);

    rerender({ gameState: state, action: null, end: settlement({ reason: 'resignation' }) });
    expect(calls).toEqual([['move'], ['victory']]);

    rerender({ gameState: state, action: null, end: settlement({ reason: 'resignation', endedAt: 2 }) });
    expect(calls).toEqual([['move'], ['victory']]);
  });

  it('keeps silence for agreed draws', () => {
    const { engine, calls } = createSpyEngine();
    const state = stateWith([historyEntry(1)]);
    const { rerender } = renderOnline(engine);

    rerender({ gameState: state, action: acceptedAction({ stepNumber: 1 }), end: null });
    rerender({
      gameState: state,
      action: null,
      end: settlement({ winner: null, loser: null, reason: 'draw-agreement' }),
    });

    expect(calls).toEqual([['move']]);
  });

  it('does not play the victory phrase twice when the final move and the settlement arrive together', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderOnline(engine);

    rerender({
      gameState: stateWith([historyEntry(1)]),
      action: acceptedAction({ stepNumber: 1 }),
      end: null,
    });
    rerender({
      gameState: stateWith([historyEntry(1), winningEntry(2)]),
      action: acceptedAction({ stepNumber: 2 }),
      end: settlement({ reason: 'checkmate' }),
    });

    expect(calls).toEqual([['move'], ['move', 'victory']]);
  });

  it('keeps a finished match quiet when rejoining it', () => {
    const { engine, calls } = createSpyEngine();

    renderHook((props: OnlineProps) => useOnlineGameAudio(props.gameState, props.action, props.end, engine), {
      initialProps: {
        gameState: stateWith([winningEntry(1)]),
        action: null,
        end: settlement({ reason: 'checkmate' }),
      } as OnlineProps,
    });

    expect(calls).toEqual([]);
  });

  it('allows the next match to celebrate again after a rematch', () => {
    const { engine, calls } = createSpyEngine();
    const { rerender } = renderOnline(engine);

    rerender({
      gameState: stateWith([winningEntry(1)]),
      action: acceptedAction({ stepNumber: 1 }),
      end: settlement({ reason: 'checkmate' }),
    });
    expect(calls).toEqual([['move', 'victory']]);

    // 新的一局：历史与结算清空。
    rerender({ gameState: stateWith([]), action: null, end: null });
    rerender({
      gameState: stateWith([winningEntry(1)]),
      action: acceptedAction({ stepNumber: 1 }),
      end: settlement({ reason: 'checkmate' }),
    });

    expect(calls).toEqual([
      ['move', 'victory'],
      ['move', 'victory'],
    ]);
  });

  it('cancels pending audio and detaches gestures on unmount', () => {
    const { engine, stopAllCount } = createSpyEngine();
    const { unmount } = renderOnline(engine);

    unmount();
    expect(stopAllCount()).toBe(1);
  });
});
