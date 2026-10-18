import { useEffect, useState } from 'react';
import type { Camp } from '../game/types.js';
import type { MatchClockSnapshot } from '../network/protocol.js';

export interface PlayerClockProps {
  side: Camp;
  label?: string;
  clockSnapshot: MatchClockSnapshot | null;
  clockOffsetMs?: number;
  isCurrentTurn: boolean;
  isPaused: boolean;
  timeControlId?: string;
}

export function formatTimeDisplay(ms: number | null): string {
  if (ms === null) {
    return '--:--';
  }
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function formatStepSeconds(ms: number | null): string {
  if (ms === null) {
    return '--';
  }
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  return `${totalSeconds}s`;
}

export function PlayerClock({
  side,
  label,
  clockSnapshot,
  clockOffsetMs = 0,
  isCurrentTurn,
  isPaused,
  timeControlId,
}: PlayerClockProps) {
  const [, setTick] = useState(0);

  // 定时驱动平滑毫秒插值（100ms 刷新率）
  useEffect(() => {
    if (!clockSnapshot || isPaused || !isCurrentTurn || timeControlId === 'none') {
      return;
    }
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 100);
    return () => clearInterval(interval);
  }, [clockSnapshot, isPaused, isCurrentTurn, timeControlId]);

  if (!clockSnapshot) {
    return (
      <div className={`player-clock camp-${side}`} data-testid={`player-clock-${side}`}>
        <span className="clock-digits">--:--</span>
      </div>
    );
  }

  const playerState = side === 'red' ? clockSnapshot.red : clockSnapshot.black;
  const isUntimed = timeControlId === 'none' || playerState.baseTimeRemainingMs === null;

  // 计算距离权威采样点的本地流逝时间（结合 NTP 偏移补偿）
  const estimatedServerNow = Date.now() + clockOffsetMs;
  const elapsedSinceSnapshot =
    isCurrentTurn && !isPaused
      ? Math.max(0, estimatedServerNow - clockSnapshot.serverTime)
      : 0;

  let baseTimeRemainingMs: number | null = null;
  let stepTimeRemainingMs: number | null = null;
  let accumulatedDurationMs: number = playerState.accumulatedDurationMs;

  if (isUntimed) {
    accumulatedDurationMs += elapsedSinceSnapshot;
  } else {
    baseTimeRemainingMs = Math.max(
      0,
      (playerState.baseTimeRemainingMs ?? 0) - elapsedSinceSnapshot,
    );
    stepTimeRemainingMs = Math.max(
      0,
      (playerState.stepTimeRemainingMs ?? 0) - elapsedSinceSnapshot,
    );
  }

  const isUrgent = !isUntimed && baseTimeRemainingMs !== null && baseTimeRemainingMs < 60_000 && isCurrentTurn;
  const isExtreme = !isUntimed && stepTimeRemainingMs !== null && stepTimeRemainingMs <= 5_000 && isCurrentTurn;

  // 步时进度百分比（基准 step 依设置决定：standard 为 60s，blitz 为 30s）
  const fullStepSec = timeControlId === 'blitz' ? 30 : 60;
  const stepPercent = stepTimeRemainingMs !== null
    ? Math.min(100, Math.max(0, (stepTimeRemainingMs / (fullStepSec * 1000)) * 100))
    : 100;

  const baseText = isUntimed
    ? formatTimeDisplay(accumulatedDurationMs)
    : formatTimeDisplay(baseTimeRemainingMs);
  const stepText = isUntimed ? null : formatStepSeconds(stepTimeRemainingMs);

  const statusClassNames = [
    'player-clock',
    `camp-${side}`,
    isCurrentTurn ? 'turn-active' : 'turn-idle',
    isPaused ? 'clock-paused' : '',
    isUrgent ? 'urgent-warning' : '',
    isExtreme ? 'extreme-warning' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const accessibleLabel = `${label ?? (side === 'red' ? '红方' : '黑方')}时钟：局时 ${baseText}${
    stepText ? `，步时 ${stepText}` : ''
  }${isPaused ? '（已暂停）' : ''}`;

  return (
    <div
      aria-label={accessibleLabel}
      className={statusClassNames}
      data-side={side}
      data-testid={`player-clock-${side}`}
      role="timer"
    >
      {/* 步时进度环/线 */}
      {!isUntimed && stepText !== null ? (
        <div className="clock-progress-container" title={`步时剩余 ${stepText}`}>
          <svg className="clock-progress-ring" height="32" viewBox="0 0 32 32" width="32">
            <circle
              className="progress-ring-bg"
              cx="16"
              cy="16"
              fill="transparent"
              r="13"
              strokeWidth="2.5"
            />
            <circle
              className="progress-ring-bar"
              cx="16"
              cy="16"
              fill="transparent"
              r="13"
              strokeDasharray={2 * Math.PI * 13}
              strokeDashoffset={2 * Math.PI * 13 * (1 - stepPercent / 100)}
              strokeWidth="2.5"
            />
          </svg>
          <span className="step-time-text" data-testid={`step-time-${side}`}>
            {stepText}
          </span>
        </div>
      ) : null}

      <div className="clock-digits-group">
        <span className="clock-base-time" data-testid={`base-time-${side}`}>
          {baseText}
        </span>
        {isPaused ? <span className="clock-paused-badge">已暂停</span> : null}
      </div>
    </div>
  );
}
