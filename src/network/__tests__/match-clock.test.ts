import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_GRACE_MS,
  MatchClock,
  parseMatchClockSnapshot,
  parseMatchSettlement,
  type MatchClockSnapshot,
  type MatchSettlement,
} from '../match-clock.js';

describe('MatchClock engine', () => {
  it('initializes standard time control (1200s base, 60s step) correctly', () => {
    let now = 1000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    expect(clock.isTimed).toBe(true);
    expect(clock.currentTurn).toBe('red');
    expect(clock.isPaused).toBe(false);

    const snapshot = clock.getSnapshot(now);
    expect(snapshot.red.baseTimeRemainingMs).toBe(1200_000);
    expect(snapshot.red.stepTimeRemainingMs).toBe(60_000);
    expect(snapshot.black.baseTimeRemainingMs).toBe(1200_000);
    expect(snapshot.black.stepTimeRemainingMs).toBe(60_000);
    expect(snapshot.red.accumulatedDurationMs).toBe(0);
    expect(snapshot.black.accumulatedDurationMs).toBe(0);
  });

  it('deducts time only from the active turn player', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    now += 5000;
    const advanceRes = clock.advance(now);
    expect(advanceRes.timeoutResult).toBeNull();

    const snapshot = clock.getSnapshot(now);
    expect(snapshot.red.baseTimeRemainingMs).toBe(1200_000 - 5000);
    expect(snapshot.red.stepTimeRemainingMs).toBe(60_000 - 5000);
    expect(snapshot.red.accumulatedDurationMs).toBe(5000);

    // Black time untouched
    expect(snapshot.black.baseTimeRemainingMs).toBe(1200_000);
    expect(snapshot.black.stepTimeRemainingMs).toBe(60_000);
    expect(snapshot.black.accumulatedDurationMs).toBe(0);
  });

  it('switches turn on action and resets next player step time', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    now += 8000;
    const actionRes = clock.onAction(now);
    expect(actionRes.ok).toBe(true);
    expect(clock.currentTurn).toBe('black');

    const snapshot = clock.getSnapshot(now);
    expect(snapshot.red.baseTimeRemainingMs).toBe(1200_000 - 8000);
    expect(snapshot.black.stepTimeRemainingMs).toBe(60_000); // fresh 60s for black

    // Black thinks for 12s and acts
    now += 12_000;
    const actionRes2 = clock.onAction(now);
    expect(actionRes2.ok).toBe(true);
    expect(clock.currentTurn).toBe('red');

    const snapshot2 = clock.getSnapshot(now);
    expect(snapshot2.black.baseTimeRemainingMs).toBe(1200_000 - 12_000);
    expect(snapshot2.black.accumulatedDurationMs).toBe(12_000);
    expect(snapshot2.red.stepTimeRemainingMs).toBe(60_000); // fresh 60s for red
  });

  it('triggers step timeout when stepTime reaches zero', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    now += 60_000;
    const res = clock.advance(now);
    expect(res.timeoutResult).not.toBeNull();
    expect(res.timeoutResult?.winner).toBe('black');
    expect(res.timeoutResult?.loser).toBe('red');
    expect(res.timeoutResult?.reason).toBe('step-timeout');
    expect(res.timeoutResult?.redDurationSeconds).toBe(60);
    expect(res.timeoutResult?.blackDurationSeconds).toBe(0);

    // Further actions rejected
    const actionRes = clock.onAction(now);
    expect(actionRes.ok).toBe(false);
  });

  it('triggers match timeout when baseTime expires before stepTime', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 10, // only 10s base time
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    now += 10_000;
    const res = clock.advance(now);
    expect(res.timeoutResult).not.toBeNull();
    expect(res.timeoutResult?.winner).toBe('black');
    expect(res.timeoutResult?.reason).toBe('match-timeout');
  });

  it('records duration in untimed mode without timeout', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: null,
      incrementSeconds: 0,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    expect(clock.isTimed).toBe(false);

    now += 45_000;
    clock.onAction(now); // Red took 45s

    now += 30_000;
    clock.onAction(now); // Black took 30s

    const settlement = clock.finalize('red', 'checkmate', now);
    expect(settlement.winner).toBe('red');
    expect(settlement.reason).toBe('checkmate');
    expect(settlement.redDurationSeconds).toBe(45);
    expect(settlement.blackDurationSeconds).toBe(30);
  });

  it('handles 90-second disconnect grace period and recovery', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    now += 5000;
    clock.advance(now); // Red used 5s

    // Guest drops
    const dropRes = clock.onDrop('guest', now);
    expect(dropRes.paused).toBe(true);
    expect(clock.isPaused).toBe(true);

    const grace = clock.getGraceState();
    expect(grace?.guestDeadlineMs).toBe(now + DISCONNECT_GRACE_MS);
    expect(grace?.hostDeadlineMs).toBeNull();
    expect(grace?.firstDroppedRole).toBe('guest');

    // 80 seconds pass while disconnected -> clocks frozen
    now += 80_000;
    clock.advance(now);

    const snapWhileFrozen = clock.getSnapshot(now);
    expect(snapWhileFrozen.red.baseTimeRemainingMs).toBe(1200_000 - 5000); // Still only 5s deducted!
    expect(snapWhileFrozen.red.accumulatedDurationMs).toBe(5000);

    // Guest reconnects before 90s deadline (at 85s total)
    now += 5000; // t = 10s + 5s + 80s + 5s = 100s (90s from drop would be 105s)
    const reconnectRes = clock.onReconnect('guest', now);
    expect(reconnectRes.resumed).toBe(true);
    expect(clock.isPaused).toBe(false);
    expect(clock.getGraceState()).toBeNull();

    // Red continues thinking for another 10s
    now += 10_000;
    clock.advance(now);
    const snapAfterResume = clock.getSnapshot(now);
    expect(snapAfterResume.red.baseTimeRemainingMs).toBe(1200_000 - 15_000);
    expect(snapAfterResume.red.accumulatedDurationMs).toBe(15_000);
  });

  it('triggers disconnect-timeout when 90s grace expires', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    clock.onDrop('host', now); // Host (red) drops
    expect(clock.isPaused).toBe(true);

    // Exactly 90,000ms later
    now += 90_000;
    const res = clock.advance(now);
    expect(res.timeoutResult).not.toBeNull();
    expect(res.timeoutResult?.loser).toBe('red');
    expect(res.timeoutResult?.winner).toBe('black');
    expect(res.timeoutResult?.reason).toBe('disconnect-timeout');
  });

  it('determines winner when both players drop', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    // Host drops at t=10_000
    clock.onDrop('host', now);

    // Guest drops at t=20_000
    now += 10_000;
    clock.onDrop('guest', now);

    // Fast forward to t = 100_000 (host 90s deadline expired, guest still has 10s)
    now = 100_000;
    const res = clock.advance(now);
    expect(res.timeoutResult).not.toBeNull();
    expect(res.timeoutResult?.loser).toBe('red'); // Host expired first
    expect(res.timeoutResult?.winner).toBe('black');
  });

  it('provides accurate getNextDeadlineTime for scheduling', () => {
    let now = 10_000;
    const clock = new MatchClock({
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      hostSide: 'red',
      nowFn: () => now,
      initialTime: now,
    });

    expect(clock.getNextDeadlineTime(now)).toBe(now + 60_000);

    // While paused in grace period, next deadline is grace deadline
    clock.onDrop('guest', now);
    expect(clock.getNextDeadlineTime(now)).toBe(now + 90_000);
  });
});

describe('MatchClock serialization & parsing', () => {
  it('parses valid snapshot and settlement', () => {
    const rawSnap: MatchClockSnapshot = {
      turn: 'red',
      paused: false,
      red: { baseTimeRemainingMs: 500_000, stepTimeRemainingMs: 45_000, accumulatedDurationMs: 12_000 },
      black: { baseTimeRemainingMs: 600_000, stepTimeRemainingMs: 60_000, accumulatedDurationMs: 8000 },
      serverTime: 1234567,
      sampleSeq: 3,
      disconnectGrace: null,
    };

    const parsedSnap = parseMatchClockSnapshot(rawSnap);
    expect(parsedSnap).toEqual(rawSnap);

    const rawSettlement: MatchSettlement = {
      winner: 'red',
      loser: 'black',
      reason: 'checkmate',
      redDurationSeconds: 120,
      blackDurationSeconds: 110,
      endedAt: 12345678,
    };

    const parsedSettlement = parseMatchSettlement(rawSettlement);
    expect(parsedSettlement).toEqual(rawSettlement);
  });

  it('rejects invalid snapshot structures', () => {
    expect(parseMatchClockSnapshot(null)).toBeNull();
    expect(parseMatchClockSnapshot({ turn: 'green' })).toBeNull();
    expect(parseMatchSettlement({ winner: 'blue' })).toBeNull();
    expect(parseMatchSettlement({ winner: 'red', loser: 'black', reason: 'magic' })).toBeNull();
  });
});
