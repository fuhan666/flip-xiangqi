import { useEffect, useRef, useState } from 'react';
import type { Camp, GameViewState, PieceView, PieceType, Position } from '../game/types.js';
import type { AcceptedGameAction } from '../network/client.js';
import {
  CAPTURE_GHOST_LIFETIME_MS,
  CHECK_PULSE_LIFETIME_MS,
  FLIP_HALF_MS,
  FLIP_TOTAL_MS,
  TRACE_LIFETIME_MS,
  type CaptureGhostFeedback,
  type CheckPulseFeedback,
  type FlipFeedback,
  type TraceFeedback,
} from './useBoardFeedback.js';

export interface OnlineBoardFeedback {
  displayState: GameViewState;
  flip: FlipFeedback | null;
  trace: TraceFeedback | null;
  captureGhost: CaptureGhostFeedback | null;
  checkPulse: CheckPulseFeedback | null;
}

interface OnlineFeedbackEvent {
  seq: number;
  preState: GameViewState | null;
  flip: FlipFeedback | null;
  trace: TraceFeedback | null;
  captureGhost: CaptureGhostFeedback | null;
  checkPulse: CheckPulseFeedback | null;
}

const IDLE_EVENT: OnlineFeedbackEvent = {
  seq: 0,
  preState: null,
  flip: null,
  trace: null,
  captureGhost: null,
  checkPulse: null,
};

function readPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function positionKey(position: Position): string {
  return `${position.x}-${position.y}`;
}

/**
 * 翻牌动画的「翻前帧」：只保留未知暗子（位置 + 不透明标识），
 * 不把已知阵营/棋种藏在 DOM、CSS 或动画状态里。
 */
function createUnrevealedPreState(state: GameViewState, position: Position): GameViewState {
  return {
    ...state,
    pieces: state.pieces.map((piece): PieceView => {
      if (piece.position && piece.position.x === position.x && piece.position.y === position.y) {
        return { id: piece.id, position: { ...piece.position }, revealed: false };
      }
      return piece;
    }),
  };
}

/**
 * 联机对局视觉反馈控制：
 * - 本地乐观动作：立即触发一次动画，服务端确认不重播；
 * - 远端动作：收到广播后触发一次动画；
 * - 拒绝/回滚或断线恢复全量同步：清空动画与轨迹，不补播历史动画；
 * - 遵循 prefers-reduced-motion。
 */
export function useOnlineBoardFeedback(
  gameState: GameViewState,
  lastAcceptedAction: AcceptedGameAction | null,
): OnlineBoardFeedback {
  const [event, setEvent] = useState<OnlineFeedbackEvent>(IDLE_EVENT);
  const [reducedMotion, setReducedMotion] = useState<boolean>(readPrefersReducedMotion);
  const sequenceRef = useRef(0);
  const lastAnimatedEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setReducedMotion(query.matches);
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handleChange);
      return () => query.removeEventListener('change', handleChange);
    }
    return undefined;
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setEvent(IDLE_EVENT);
    }
  }, [reducedMotion]);

  useEffect(() => {
    // 1. 无动作或尚未获得权威确认（开局初始化/全量恢复/拒绝回滚）
    //    -> 重置事件，清理动画：未确认的动作绝不提前揭示棋子身份。
    if (!lastAcceptedAction || !lastAcceptedAction.confirmed) {
      setEvent(IDLE_EVENT);
      lastAnimatedEventIdRef.current = null;
      return;
    }

    // 2. 该事件已经播放过动画（本地乐观先播，服务端确认带相同 eventId 不重播）
    const eventId = lastAcceptedAction.eventId ?? `${lastAcceptedAction.stepNumber}:${lastAcceptedAction.source}`;
    if (lastAnimatedEventIdRef.current === eventId) {
      return;
    }

    lastAnimatedEventIdRef.current = eventId;

    if (readPrefersReducedMotion()) {
      setEvent(IDLE_EVENT);
      return;
    }

    const length = gameState.actionHistory.length;
    if (length === 0) {
      return;
    }

    const entry = gameState.actionHistory[length - 1];
    const seq = sequenceRef.current + 1;
    sequenceRef.current = seq;
    const action = entry.action;
    const capture = entry.consequences.find((consequence) => consequence.type === 'capture');

    const preState = action.type === 'flip' ? createUnrevealedPreState(gameState, action.position) : null;

    setEvent({
      seq,
      preState,
      flip: action.type === 'flip' ? { cellKey: positionKey(action.position), phase: 'back' } : null,
      trace:
        action.type === 'move'
          ? { eventKey: `trace-${seq}`, from: action.from, to: action.to }
          : null,
      captureGhost:
        capture && capture.type === 'capture'
          ? {
              eventKey: `ghost-${seq}`,
              position: capture.position,
              camp: capture.piece.camp as Camp,
              pieceType: capture.piece.type as PieceType,
            }
          : null,
      checkPulse:
        entry.winner === null && entry.consequences.some((consequence) => consequence.type === 'check')
          ? { eventKey: `pulse-${seq}` }
          : null,
    });
  }, [gameState, lastAcceptedAction]);

  const { seq } = event;

  useEffect(() => {
    if (seq === 0) {
      return undefined;
    }

    const timers: number[] = [];
    const schedule = (delay: number, update: (current: OnlineFeedbackEvent) => OnlineFeedbackEvent) => {
      timers.push(
        window.setTimeout(() => {
          setEvent((current) => (current.seq === seq ? update(current) : current));
        }, delay),
      );
    };

    if (event.flip) {
      schedule(FLIP_HALF_MS, (current) => ({
        ...current,
        flip: current.flip ? { ...current.flip, phase: 'front' } : null,
      }));
      schedule(FLIP_TOTAL_MS, (current) => ({
        ...current,
        flip: null,
        preState: null,
      }));
    }
    if (event.trace) {
      schedule(TRACE_LIFETIME_MS, (current) => ({ ...current, trace: null }));
    }
    if (event.captureGhost) {
      schedule(CAPTURE_GHOST_LIFETIME_MS, (current) => ({ ...current, captureGhost: null }));
    }
    if (event.checkPulse) {
      schedule(CHECK_PULSE_LIFETIME_MS, (current) => ({ ...current, checkPulse: null }));
    }

    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
    };
  }, [seq]);

  const revealPending = event.flip !== null && event.flip.phase === 'back' && event.preState !== null;

  return {
    displayState: revealPending && event.preState ? event.preState : gameState,
    flip: event.flip,
    trace: event.trace,
    captureGhost: event.captureGhost,
    checkPulse: event.checkPulse,
  };
}
