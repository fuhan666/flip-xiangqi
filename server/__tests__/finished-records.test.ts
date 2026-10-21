// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinishedRecordArchive, buildFinishedMatchRecord, FINISHED_RECORD_TTL_MS } from '../finished-records';
import { createMatch, finalizeMatch } from '../../src/network/match';
import { buildStartParameters, createLobbyState } from '../../src/network/lobby';

function settledMatch(reason: 'resignation' | 'draw-agreement' = 'resignation') {
  const startParameters = buildStartParameters({
    roomId: 'room-1',
    host: { memberId: 'host-1', name: '房主' },
    guest: { memberId: 'guest-1', name: '客人' },
    settings: { ...createLobbyState().settings, sidePreference: 'host-red', locked: true },
    hostSide: 'red',
  });
  const match = createMatch({ matchId: 'm1', seed: 2, startParameters });
  return finalizeMatch(match, reason === 'resignation' ? 'red' : null, reason, 5_000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FinishedRecordArchive', () => {
  it('按 matchId 首次写入后不可覆盖、不可续期', () => {
    vi.useFakeTimers();
    let now = 1_000;
    const archive = new FinishedRecordArchive({ nowFn: () => now, sweepIntervalMs: 10_000 });
    const first = archive.archive({ roomId: 'room-1', matchId: 'm1', memberIds: ['a', 'b'], endedAt: now, json: '{"v":1}', text: 't1' });
    expect(first!.expiresAt).toBe(1_000 + FINISHED_RECORD_TTL_MS);

    now += 60_000;
    expect(archive.archive({ roomId: 'room-1', matchId: 'm1', memberIds: ['a', 'b'], endedAt: now, json: '{"v":2}', text: 't2' })).toBeNull();
    expect(archive.get('m1')).toMatchObject({ json: '{"v":1}', text: 't1', expiresAt: 1_000 + FINISHED_RECORD_TTL_MS });
    archive.dispose();
  });

  it('到期后读写都不可用，且无需读取也会在定时清理中释放', () => {
    vi.useFakeTimers();
    let now = 0;
    const archive = new FinishedRecordArchive({ nowFn: () => now, ttlMs: 1_000, sweepIntervalMs: 500 });
    archive.archive({ roomId: 'room-1', matchId: 'm1', memberIds: ['a'], endedAt: 0, json: '{}', text: '' });

    now = 999;
    expect(archive.get('m1')).not.toBeNull();
    now = 1_000;
    expect(archive.get('m1')).toBeNull();

    archive.archive({ roomId: 'room-1', matchId: 'm2', memberIds: ['a'], endedAt: now, json: '{}', text: '' });
    now += 5_000;
    vi.advanceTimersByTime(5_000);
    expect(archive.summaries()).toEqual([]);
    archive.dispose();
  });
});

describe('buildFinishedMatchRecord', () => {
  it('拒绝未结算对局', () => {
    const startParameters = buildStartParameters({
      roomId: 'room-1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { ...createLobbyState().settings, sidePreference: 'host-red', locked: true },
      hostSide: 'red',
    });
    const match = createMatch({ matchId: 'm1', seed: 2, startParameters });
    expect(() => buildFinishedMatchRecord(match)).toThrow('尚未结算');
  });

  it('结果、总用时与零步结算都来自权威数据', () => {
    const match = settledMatch('draw-agreement');
    const { json, text } = buildFinishedMatchRecord(match);
    expect(JSON.parse(json).result).toEqual({
      winner: null,
      reason: 'draw-agreement',
      totalSteps: 0,
      durationSeconds: match.settlement!.redDurationSeconds + match.settlement!.blackDurationSeconds,
      timeBasis: 'player-clocks',
    });
    expect(text).toContain('双方和棋');
    expect(JSON.parse(json).opening).toEqual({ mode: 'online', seats: { red: '房主', black: '客人' } });
  });
});
