import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatStepSeconds, formatTimeDisplay, PlayerClock } from '../PlayerClock.js';
import type { MatchClockSnapshot } from '../../network/protocol.js';

describe('PlayerClock component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats time display correctly', () => {
    expect(formatTimeDisplay(null)).toBe('--:--');
    expect(formatTimeDisplay(0)).toBe('00:00');
    expect(formatTimeDisplay(5000)).toBe('00:05');
    expect(formatTimeDisplay(65000)).toBe('01:05');
    expect(formatTimeDisplay(1200000)).toBe('20:00');
    expect(formatStepSeconds(null)).toBe('--');
    expect(formatStepSeconds(5000)).toBe('5s');
    expect(formatStepSeconds(60000)).toBe('60s');
  });

  it('renders base time and step time for standard time control', () => {
    const clockSnapshot: MatchClockSnapshot = {
      turn: 'red',
      paused: false,
      serverTime: 10_000,
      sampleSeq: 1,
      disconnectGrace: null,
      red: {
        baseTimeRemainingMs: 1200_000,
        stepTimeRemainingMs: 60_000,
        accumulatedDurationMs: 0,
      },
      black: {
        baseTimeRemainingMs: 1200_000,
        stepTimeRemainingMs: 60_000,
        accumulatedDurationMs: 0,
      },
    };

    render(
      <PlayerClock
        clockOffsetMs={0}
        clockSnapshot={clockSnapshot}
        isCurrentTurn={true}
        isPaused={false}
        label="红方"
        side="red"
        timeControlId="standard"
      />,
    );

    expect(screen.getByTestId('base-time-red')).toHaveTextContent('20:00');
    expect(screen.getByTestId('step-time-red')).toHaveTextContent('60s');
    expect(screen.getByTestId('player-clock-red')).toHaveClass('turn-active');
  });

  it('applies urgent-warning and extreme-warning classes when time is running low', () => {
    const clockSnapshot: MatchClockSnapshot = {
      turn: 'red',
      paused: false,
      serverTime: 10_000,
      sampleSeq: 1,
      disconnectGrace: null,
      red: {
        baseTimeRemainingMs: 45_000, // < 60s -> urgent
        stepTimeRemainingMs: 4_000,  // <= 5s -> extreme
        accumulatedDurationMs: 1155_000,
      },
      black: {
        baseTimeRemainingMs: 1200_000,
        stepTimeRemainingMs: 60_000,
        accumulatedDurationMs: 0,
      },
    };

    render(
      <PlayerClock
        clockOffsetMs={0}
        clockSnapshot={clockSnapshot}
        isCurrentTurn={true}
        isPaused={false}
        side="red"
        timeControlId="standard"
      />,
    );

    const clockEl = screen.getByTestId('player-clock-red');
    expect(clockEl).toHaveClass('urgent-warning');
    expect(clockEl).toHaveClass('extreme-warning');
  });

  it('displays paused badge when clock is paused', () => {
    const clockSnapshot: MatchClockSnapshot = {
      turn: 'red',
      paused: true,
      serverTime: 10_000,
      sampleSeq: 1,
      disconnectGrace: null,
      red: {
        baseTimeRemainingMs: 1100_000,
        stepTimeRemainingMs: 50_000,
        accumulatedDurationMs: 100_000,
      },
      black: {
        baseTimeRemainingMs: 1200_000,
        stepTimeRemainingMs: 60_000,
        accumulatedDurationMs: 0,
      },
    };

    render(
      <PlayerClock
        clockOffsetMs={0}
        clockSnapshot={clockSnapshot}
        isCurrentTurn={true}
        isPaused={true}
        side="red"
        timeControlId="standard"
      />,
    );

    expect(screen.getByTestId('player-clock-red')).toHaveClass('clock-paused');
    expect(screen.getByText('已暂停')).toBeInTheDocument();
  });
});
