/**
 * 权威对局计时引擎与断线宽限期模型：
 * - 纯 TypeScript 实现（不依赖 Node API 与 DOM API），供服务端与客户端共用；
 * - 服务端维护权威时钟，单调时钟计算时间差；
 * - 90 秒断线宽限期状态机；
 * - 终局结算与双方用时统计。
 */
import type { Camp } from '../game/types.js';
import type { Role } from './protocol.js';

export const DISCONNECT_GRACE_MS = 90_000;

export type EndgameReason =
  | 'checkmate'
  | 'king-captured'
  | 'match-timeout'
  | 'step-timeout'
  | 'disconnect-timeout'
  | 'resignation'
  | 'draw-agreement';

export interface MatchSettlement {
  winner: Camp | null;
  loser: Camp | null;
  reason: EndgameReason;
  redDurationSeconds: number;
  blackDurationSeconds: number;
  endedAt: number;
}

export interface PlayerClockState {
  baseTimeRemainingMs: number | null;
  stepTimeRemainingMs: number | null;
  accumulatedDurationMs: number;
}

export interface DisconnectGraceState {
  hostDeadlineMs: number | null;
  guestDeadlineMs: number | null;
  firstDroppedRole: Role | null;
}

export interface MatchClockSnapshot {
  turn: Camp;
  paused: boolean;
  red: PlayerClockState;
  black: PlayerClockState;
  serverTime: number;
  sampleSeq: number;
  disconnectGrace: DisconnectGraceState | null;
}

export interface MatchClockOptions {
  baseTimeSeconds: number | null;
  incrementSeconds: number;
  hostSide: Camp;
  nowFn?: () => number;
  initialTime?: number;
}

function clonePlayerClockState(source: PlayerClockState): PlayerClockState {
  return {
    baseTimeRemainingMs: source.baseTimeRemainingMs,
    stepTimeRemainingMs: source.stepTimeRemainingMs,
    accumulatedDurationMs: source.accumulatedDurationMs,
  };
}

export class MatchClock {
  private readonly baseTimeSeconds: number | null;
  private readonly incrementSeconds: number;
  private readonly hostSide: Camp;
  private readonly guestSide: Camp;
  private readonly nowFn: () => number;

  private turn: Camp = 'red';
  private paused = false;
  private isNegotiationPaused = false;
  private lastTickTime: number;
  private sampleSeq = 0;

  private red: PlayerClockState;
  private black: PlayerClockState;
  private checkpoints: Array<{ turn: Camp; red: PlayerClockState; black: PlayerClockState }> = [];

  private hostGraceDeadlineMs: number | null = null;
  private guestGraceDeadlineMs: number | null = null;
  private firstDroppedRole: Role | null = null;

  private settlement: MatchSettlement | null = null;

  constructor(options: MatchClockOptions) {
    this.baseTimeSeconds = options.baseTimeSeconds;
    this.incrementSeconds = options.incrementSeconds;
    this.hostSide = options.hostSide;
    this.guestSide = options.hostSide === 'red' ? 'black' : 'red';
    this.nowFn = options.nowFn ?? (() => Date.now());

    const startTime = options.initialTime ?? this.nowFn();
    this.lastTickTime = startTime;

    const initialBase = options.baseTimeSeconds !== null ? Math.max(0, options.baseTimeSeconds * 1000) : null;
    const initialStep = options.baseTimeSeconds !== null ? Math.max(0, options.incrementSeconds * 1000) : null;

    this.red = {
      baseTimeRemainingMs: initialBase,
      stepTimeRemainingMs: initialStep,
      accumulatedDurationMs: 0,
    };
    this.black = {
      baseTimeRemainingMs: initialBase,
      stepTimeRemainingMs: initialStep,
      accumulatedDurationMs: 0,
    };
  }

  public get isTimed(): boolean {
    return this.baseTimeSeconds !== null;
  }

  public get currentTurn(): Camp {
    return this.turn;
  }

  public get isPaused(): boolean {
    return this.paused || this.isNegotiationPaused;
  }

  public getSettlement(): MatchSettlement | null {
    return this.settlement ? { ...this.settlement } : null;
  }

  public getGraceState(): DisconnectGraceState | null {
    if (this.hostGraceDeadlineMs === null && this.guestGraceDeadlineMs === null) {
      return null;
    }
    return {
      hostDeadlineMs: this.hostGraceDeadlineMs,
      guestDeadlineMs: this.guestGraceDeadlineMs,
      firstDroppedRole: this.firstDroppedRole,
    };
  }

  public pauseNegotiation(now: number = this.nowFn()): void {
    this.advance(now);
    this.isNegotiationPaused = true;
    this.lastTickTime = now;
    this.sampleSeq++;
  }

  public resumeNegotiation(now: number = this.nowFn()): void {
    this.isNegotiationPaused = false;
    this.lastTickTime = now;
    this.sampleSeq++;
  }

  public saveCheckpoint(): void {
    this.checkpoints.push({
      turn: this.turn,
      red: clonePlayerClockState(this.red),
      black: clonePlayerClockState(this.black),
    });
  }

  public undoLastAction(now: number = this.nowFn()): boolean {
    if (this.checkpoints.length === 0) {
      return false;
    }
    const cp = this.checkpoints.pop()!;
    this.turn = cp.turn;
    this.red = clonePlayerClockState(cp.red);
    this.black = clonePlayerClockState(cp.black);
    this.lastTickTime = now;
    this.sampleSeq++;
    return true;
  }

  public advance(now: number = this.nowFn()): { timeoutResult: MatchSettlement | null; changed: boolean } {
    if (this.settlement) {
      return { timeoutResult: this.settlement, changed: false };
    }

    if (this.isPaused) {
      if (this.paused) {
        const hostExpired = this.hostGraceDeadlineMs !== null && now >= this.hostGraceDeadlineMs;
        const guestExpired = this.guestGraceDeadlineMs !== null && now >= this.guestGraceDeadlineMs;

        if (hostExpired && guestExpired) {
          if (this.hostGraceDeadlineMs! < this.guestGraceDeadlineMs!) {
            return { timeoutResult: this.finalizeByRoleTimeout('host', now), changed: true };
          } else if (this.guestGraceDeadlineMs! < this.hostGraceDeadlineMs!) {
            return { timeoutResult: this.finalizeByRoleTimeout('guest', now), changed: true };
          } else {
            const loserRole = this.firstDroppedRole ?? 'host';
            return { timeoutResult: this.finalizeByRoleTimeout(loserRole, now), changed: true };
          }
        } else if (hostExpired) {
          return { timeoutResult: this.finalizeByRoleTimeout('host', now), changed: true };
        } else if (guestExpired) {
          return { timeoutResult: this.finalizeByRoleTimeout('guest', now), changed: true };
        }
      }

      this.lastTickTime = now;
      return { timeoutResult: null, changed: false };
    }

    const elapsed = Math.max(0, now - this.lastTickTime);
    this.lastTickTime = now;

    if (elapsed === 0) {
      return { timeoutResult: null, changed: false };
    }

    const active = this.turn === 'red' ? this.red : this.black;
    active.accumulatedDurationMs += elapsed;

    if (this.isTimed) {
      if (active.baseTimeRemainingMs !== null) {
        active.baseTimeRemainingMs -= elapsed;
      }
      if (active.stepTimeRemainingMs !== null) {
        active.stepTimeRemainingMs -= elapsed;
      }

      if (active.baseTimeRemainingMs !== null && active.baseTimeRemainingMs <= 0) {
        active.baseTimeRemainingMs = 0;
        const loser = this.turn;
        const winner = loser === 'red' ? 'black' : 'red';
        return { timeoutResult: this.finalize(winner, 'match-timeout', now), changed: true };
      }

      if (active.stepTimeRemainingMs !== null && active.stepTimeRemainingMs <= 0) {
        active.stepTimeRemainingMs = 0;
        const loser = this.turn;
        const winner = loser === 'red' ? 'black' : 'red';
        return { timeoutResult: this.finalize(winner, 'step-timeout', now), changed: true };
      }
    }

    return { timeoutResult: null, changed: true };
  }

  public onAction(now: number = this.nowFn()): { ok: boolean; reason?: string } {
    const advanceResult = this.advance(now);
    if (advanceResult.timeoutResult) {
      return { ok: false, reason: '对局已超时结束' };
    }

    if (this.isPaused) {
      return { ok: false, reason: '对局处于暂停冻结状态，暂无法操作' };
    }

    // 切换行动方并重置新回合步时
    this.turn = this.turn === 'red' ? 'black' : 'red';
    if (this.isTimed) {
      const nextActive = this.turn === 'red' ? this.red : this.black;
      nextActive.stepTimeRemainingMs = this.incrementSeconds * 1000;
    }
    this.lastTickTime = now;
    this.sampleSeq++;

    return { ok: true };
  }

  public onDrop(role: Role, now: number = this.nowFn()): { settlement: MatchSettlement | null; paused: boolean } {
    const advanceResult = this.advance(now);
    if (advanceResult.timeoutResult) {
      return { settlement: advanceResult.timeoutResult, paused: false };
    }

    if (role === 'host') {
      if (this.hostGraceDeadlineMs === null) {
        this.hostGraceDeadlineMs = now + DISCONNECT_GRACE_MS;
      }
    } else {
      if (this.guestGraceDeadlineMs === null) {
        this.guestGraceDeadlineMs = now + DISCONNECT_GRACE_MS;
      }
    }

    if (!this.firstDroppedRole) {
      this.firstDroppedRole = role;
    }

    this.paused = true;
    this.lastTickTime = now;
    this.sampleSeq++;

    return { settlement: null, paused: true };
  }

  public onReconnect(role: Role, now: number = this.nowFn()): { settlement: MatchSettlement | null; resumed: boolean } {
    const advanceResult = this.advance(now);
    if (advanceResult.timeoutResult) {
      return { settlement: advanceResult.timeoutResult, resumed: false };
    }

    if (role === 'host') {
      this.hostGraceDeadlineMs = null;
    } else {
      this.guestGraceDeadlineMs = null;
    }

    if (this.hostGraceDeadlineMs === null && this.guestGraceDeadlineMs === null) {
      this.firstDroppedRole = null;
      this.paused = false;
      this.lastTickTime = now;
      this.sampleSeq++;
      return { settlement: null, resumed: true };
    }

    this.lastTickTime = now;
    this.sampleSeq++;
    return { settlement: null, resumed: false };
  }

  private finalizeByRoleTimeout(loserRole: Role, now: number): MatchSettlement {
    const loserSide = loserRole === 'host' ? this.hostSide : this.guestSide;
    const winnerSide = loserSide === 'red' ? 'black' : 'red';
    return this.finalize(winnerSide, 'disconnect-timeout', now);
  }

  public finalize(winner: Camp, reason: EndgameReason, now: number = this.nowFn()): MatchSettlement {
    if (this.settlement) {
      return this.settlement;
    }

    const loser: Camp = winner === 'red' ? 'black' : 'red';
    const redDurationSeconds = Math.max(0, Math.round(this.red.accumulatedDurationMs / 1000));
    const blackDurationSeconds = Math.max(0, Math.round(this.black.accumulatedDurationMs / 1000));

    this.settlement = {
      winner,
      loser,
      reason,
      redDurationSeconds,
      blackDurationSeconds,
      endedAt: now,
    };

    this.paused = true;
    this.sampleSeq++;

    return this.settlement;
  }

  public finalizeDraw(reason: EndgameReason = 'draw-agreement', now: number = this.nowFn()): MatchSettlement {
    if (this.settlement) {
      return this.settlement;
    }

    const redDurationSeconds = Math.max(0, Math.round(this.red.accumulatedDurationMs / 1000));
    const blackDurationSeconds = Math.max(0, Math.round(this.black.accumulatedDurationMs / 1000));

    this.settlement = {
      winner: null,
      loser: null,
      reason,
      redDurationSeconds,
      blackDurationSeconds,
      endedAt: now,
    };

    this.paused = true;
    this.sampleSeq++;

    return this.settlement;
  }

  public getNextDeadlineTime(now: number = this.nowFn()): number | null {
    if (this.settlement) {
      return null;
    }

    if (this.isPaused) {
      if (!this.paused) {
        return null;
      }
      const deadlines: number[] = [];
      if (this.hostGraceDeadlineMs !== null) {
        deadlines.push(this.hostGraceDeadlineMs);
      }
      if (this.guestGraceDeadlineMs !== null) {
        deadlines.push(this.guestGraceDeadlineMs);
      }
      if (deadlines.length === 0) {
        return null;
      }
      return Math.min(...deadlines);
    }

    if (!this.isTimed) {
      return null;
    }

    const active = this.turn === 'red' ? this.red : this.black;
    const remainingList: number[] = [];
    if (active.baseTimeRemainingMs !== null) {
      remainingList.push(active.baseTimeRemainingMs);
    }
    if (active.stepTimeRemainingMs !== null) {
      remainingList.push(active.stepTimeRemainingMs);
    }
    if (remainingList.length === 0) {
      return null;
    }

    const minRemaining = Math.max(0, Math.min(...remainingList));
    return now + minRemaining;
  }

  public getSnapshot(now: number = this.nowFn()): MatchClockSnapshot {
    return {
      turn: this.turn,
      paused: this.isPaused,
      red: clonePlayerClockState(this.red),
      black: clonePlayerClockState(this.black),
      serverTime: now,
      sampleSeq: this.sampleSeq,
      disconnectGrace: this.getGraceState(),
    };
  }
}

// —— 校验与解析 ——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VALID_ENDGAME_REASONS = new Set<string>([
  'checkmate',
  'king-captured',
  'match-timeout',
  'step-timeout',
  'disconnect-timeout',
  'resignation',
  'draw-agreement',
]);

export function isEndgameReason(value: unknown): value is EndgameReason {
  return typeof value === 'string' && VALID_ENDGAME_REASONS.has(value);
}

export function parsePlayerClockState(value: unknown): PlayerClockState | null {
  if (!isRecord(value)) {
    return null;
  }
  const { baseTimeRemainingMs, stepTimeRemainingMs, accumulatedDurationMs } = value;
  if (
    baseTimeRemainingMs !== null &&
    (typeof baseTimeRemainingMs !== 'number' || !Number.isFinite(baseTimeRemainingMs) || baseTimeRemainingMs < 0)
  ) {
    return null;
  }
  if (
    stepTimeRemainingMs !== null &&
    (typeof stepTimeRemainingMs !== 'number' || !Number.isFinite(stepTimeRemainingMs) || stepTimeRemainingMs < 0)
  ) {
    return null;
  }
  if (
    typeof accumulatedDurationMs !== 'number' ||
    !Number.isFinite(accumulatedDurationMs) ||
    accumulatedDurationMs < 0
  ) {
    return null;
  }
  return {
    baseTimeRemainingMs,
    stepTimeRemainingMs,
    accumulatedDurationMs,
  };
}

export function parseDisconnectGraceState(value: unknown): DisconnectGraceState | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const { hostDeadlineMs, guestDeadlineMs, firstDroppedRole } = value;
  if (
    hostDeadlineMs !== null &&
    (typeof hostDeadlineMs !== 'number' || !Number.isFinite(hostDeadlineMs) || hostDeadlineMs < 0)
  ) {
    return null;
  }
  if (
    guestDeadlineMs !== null &&
    (typeof guestDeadlineMs !== 'number' || !Number.isFinite(guestDeadlineMs) || guestDeadlineMs < 0)
  ) {
    return null;
  }
  if (firstDroppedRole !== null && firstDroppedRole !== 'host' && firstDroppedRole !== 'guest') {
    return null;
  }
  return {
    hostDeadlineMs,
    guestDeadlineMs,
    firstDroppedRole: firstDroppedRole ?? null,
  };
}

export function parseMatchClockSnapshot(value: unknown): MatchClockSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const { turn, paused, red, black, serverTime, sampleSeq, disconnectGrace } = value;
  if (turn !== 'red' && turn !== 'black') {
    return null;
  }
  if (typeof paused !== 'boolean') {
    return null;
  }
  const parsedRed = parsePlayerClockState(red);
  const parsedBlack = parsePlayerClockState(black);
  if (!parsedRed || !parsedBlack) {
    return null;
  }
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime) || serverTime < 0) {
    return null;
  }
  if (typeof sampleSeq !== 'number' || !Number.isInteger(sampleSeq) || sampleSeq < 0) {
    return null;
  }
  const parsedGrace = disconnectGrace ? parseDisconnectGraceState(disconnectGrace) : null;
  return {
    turn,
    paused,
    red: parsedRed,
    black: parsedBlack,
    serverTime,
    sampleSeq,
    disconnectGrace: parsedGrace,
  };
}

export function parseMatchSettlement(value: unknown): MatchSettlement | null {
  if (!isRecord(value)) {
    return null;
  }
  const { winner, loser, reason, redDurationSeconds, blackDurationSeconds, endedAt } = value;
  if (!isEndgameReason(reason)) {
    return null;
  }
  if (reason === 'draw-agreement') {
    if (winner !== null || loser !== null) {
      return null;
    }
  } else {
    if ((winner !== 'red' && winner !== 'black') || (loser !== 'red' && loser !== 'black') || winner === loser) {
      return null;
    }
  }
  if (
    typeof redDurationSeconds !== 'number' ||
    !Number.isFinite(redDurationSeconds) ||
    redDurationSeconds < 0 ||
    typeof blackDurationSeconds !== 'number' ||
    !Number.isFinite(blackDurationSeconds) ||
    blackDurationSeconds < 0 ||
    typeof endedAt !== 'number' ||
    !Number.isFinite(endedAt) ||
    endedAt < 0
  ) {
    return null;
  }
  return {
    winner,
    loser,
    reason,
    redDurationSeconds,
    blackDurationSeconds,
    endedAt,
  };
}
