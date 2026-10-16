import { useEffect, useRef, useState } from 'react';
import type { Camp, GameState, PieceType, Position } from '../game';

export const FLIP_HALF_MS = 180;
export const FLIP_TOTAL_MS = 360;
export const TRACE_LIFETIME_MS = 900;
export const CAPTURE_GHOST_LIFETIME_MS = 240;
export const CHECK_PULSE_LIFETIME_MS = 1080;

export type FlipPhase = 'back' | 'front';
export type LegalMoveHint = 'empty' | 'capture';

export interface FlipFeedback {
  cellKey: string;
  phase: FlipPhase;
}

export interface TraceFeedback {
  eventKey: string;
  from: Position;
  to: Position;
}

export interface CaptureGhostFeedback {
  eventKey: string;
  position: Position;
  camp: Camp;
  pieceType: PieceType;
}

export interface CheckPulseFeedback {
  eventKey: string;
}

export interface BoardFeedback {
  displayState: GameState;
  flip: FlipFeedback | null;
  trace: TraceFeedback | null;
  captureGhost: CaptureGhostFeedback | null;
  checkPulse: CheckPulseFeedback | null;
}

interface FeedbackEvent {
  seq: number;
  preState: GameState | null;
  flip: FlipFeedback | null;
  trace: TraceFeedback | null;
  captureGhost: CaptureGhostFeedback | null;
  checkPulse: CheckPulseFeedback | null;
}

const IDLE_EVENT: FeedbackEvent = {
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
 * Drives the transient visual feedback around successful actions while the
 * rule engine keeps full authority over the game state.
 *
 * - Only newly appended successful history entries start feedback; illegal
 *   actions, selection churn and the first mount never replay animations.
 * - Flip feedback keeps every presentation surface on the pre-action snapshot
 *   until the back half of the flip has finished, so the hidden piece identity
 *   cannot leak early.
 * - Undo, restart, unmount and superseding events cancel timers and make stale
 *   callbacks no-ops through the event sequence guard.
 */
export function useBoardFeedback(gameState: GameState): BoardFeedback {
  const [event, setEvent] = useState<FeedbackEvent>(IDLE_EVENT);
  const [reducedMotion, setReducedMotion] = useState<boolean>(readPrefersReducedMotion);
  const historyLengthRef = useRef<number | null>(null);
  const previousGameRef = useRef<GameState>(gameState);
  const sequenceRef = useRef(0);

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
    const length = gameState.actionHistory.length;
    const previousLength = historyLengthRef.current;
    const previousGame = previousGameRef.current;
    historyLengthRef.current = length;
    previousGameRef.current = gameState;

    if (previousLength === null) {
      return;
    }

    if (length === previousLength) {
      return;
    }

    if (length < previousLength || readPrefersReducedMotion()) {
      setEvent(IDLE_EVENT);
      return;
    }

    const entry = gameState.actionHistory[length - 1];
    const seq = sequenceRef.current + 1;
    sequenceRef.current = seq;
    const action = entry.action;
    const capture = entry.consequences.find((consequence) => consequence.type === 'capture');

    setEvent({
      seq,
      preState: previousGame,
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
              camp: capture.piece.camp,
              pieceType: capture.piece.type,
            }
          : null,
      checkPulse:
        entry.winner === null && entry.consequences.some((consequence) => consequence.type === 'check')
          ? { eventKey: `pulse-${seq}` }
          : null,
    });
  }, [gameState]);

  const { seq } = event;

  useEffect(() => {
    if (seq === 0) {
      return undefined;
    }

    const timers: number[] = [];
    const schedule = (delay: number, update: (current: FeedbackEvent) => FeedbackEvent) => {
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
    displayState: revealPending ? (event.preState as GameState) : gameState,
    flip: event.flip,
    trace: event.trace,
    captureGhost: event.captureGhost,
    checkPulse: event.checkPulse,
  };
}
