import { describe, expect, it } from 'vitest';
import { createRecord, parseRecord, recordJSON, recordText, replayFrame } from '../record';
import { snapshotState } from '../../game';
import { applyMatchAction, createMatch, snapshotMatch } from '../../network/match';
import { buildStartParameters } from '../../network/lobby';
import { playedGame } from './fixture';

function fixture() {
  const { initial, final, frames } = playedGame();
  const record = createRecord(initial, final, { mode: 'local', seats: { red: '红方', black: '黑方' } }, { winner: 'red', reason: 'checkmate', durationSeconds: 90, timeBasis: 'elapsed' });
  return { initial, final, frames, record };
}
describe('game record projection and validation', () => {
  it('round trips every real frame including opponent flips, captures, undo and a hidden-piece checkmate', () => {
    const { final, frames, record } = fixture();
    expect(final.winner).toBe('red');
    expect(final.pieces.some((p) => !p.revealed)).toBe(true);
    const loaded = parseRecord(recordJSON(record));
    const before = recordJSON(loaded);
    for (const step of [25, 0, 11, 24, 1, ...frames.keys()]) {
      expect(snapshotState(replayFrame(loaded, step))).toEqual(snapshotState(frames[step]));
    }
    expect(recordJSON(loaded)).toBe(before);
    expect(loaded.moves).toHaveLength(25);
    expect(recordText(loaded).split('\n').filter((line) => /^\d+\./.test(line))).toHaveLength(25);
    expect(recordText(loaded)).toContain('耗时 未知');
    expect(recordText(loaded)).toContain('将死');
  });
  it.each(['resignation', 'draw-agreement', 'match-timeout', 'step-timeout', 'disconnect-timeout'] as const)('restores zero-step %s without inventing a move', (reason) => {
    const { initial } = fixture();
    const winner = reason === 'draw-agreement' ? null : 'black';
    const record = createRecord(initial, { ...initial, winner }, { mode: 'online', seed: 2, seats: { red: '红方', black: '黑方' } }, { winner, reason, durationSeconds: 19, timeBasis: 'player-clocks' });
    const loaded = parseRecord(recordJSON(record));
    expect(replayFrame(loaded, 0).winner).toBe(winner);
    expect(loaded.moves).toEqual([]);
  });
  it('shows external settlement only on the last frame', () => {
    const { frames } = fixture();
    const initial = frames[0];
    const record = createRecord(initial, { ...frames[1], winner: 'black' }, { mode: 'online', seats: { red: '红方', black: '黑方' } }, { winner: 'black', reason: 'resignation', durationSeconds: 20, timeBasis: 'player-clocks' });
    const loaded = parseRecord(recordJSON(record));
    expect(replayFrame(loaded, 0).winner).toBeNull();
    expect(replayFrame(loaded, 1).winner).toBe('black');
    expect(loaded.moves[0].durationSeconds).toBeNull();
  });
  it.each([
    (r: any) => { r.schemaVersion = 9; },
    (r: any) => { r.initial.pieces[1].id = r.initial.pieces[0].id; },
    (r: any) => { r.moves[0].action.position.x = 9; },
    (r: any) => { r.moves[0].stepNumber = 2; },
    (r: any) => { r.moves[0].action.piece.id = 'unknown'; },
    (r: any) => { r.final.pieces[0].revealed = false; },
    (r: any) => { r.result.totalSteps = 26; },
    (r: any) => { r.result.reason = 'resignation'; },
    (r: any) => { r.final.winner = 'black'; },
    (r: any) => { r.moves[0].consequences = [null]; },
    (r: any) => { r.moves[0].actor = 'black'; },
  ])('rejects malformed or inconsistent records', (damage) => {
    const { record } = fixture();
    damage(record);
    record.final.actionHistory = record.moves;
    expect(() => parseRecord(recordJSON(record))).toThrow();
  });

  it('exports local and LAN games in the same schema with the full opening and valid main line', () => {
    let now = 1_000_000;
    const startParameters = buildStartParameters({
      roomId: 'record-room',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });
    let match = createMatch({ matchId: 'm-record', seed: 42, startParameters, nowFn: () => now, initialTime: now });
    const opening = snapshotMatch(match, now).initial;

    for (let step = 0; step < 4; step += 1) {
      const actor = match.gameState.currentTurn === 'red' ? startParameters.redMemberId : startParameters.blackMemberId;
      const hidden = match.gameState.pieces.find((p) => !p.revealed && p.position)!;
      now += 1000;
      const result = applyMatchAction(match, actor, { type: 'flip', position: hidden.position! }, now);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      match = result.match;
    }
    expect(match.gameState.actionHistory).toHaveLength(4);
    expect(match.gameState.undoStack).toHaveLength(4);

    const online = createRecord(opening, snapshotState(match.gameState), { mode: 'online', seed: 42, seats: { red: '房主', black: '客人' } }, { winner: null, reason: 'draw-agreement', durationSeconds: 4, timeBasis: 'player-clocks' });
    const local = createRecord(opening, snapshotState(match.gameState), { mode: 'local', seats: { red: '本地红方', black: '本地黑方' } }, { winner: null, reason: 'draw-agreement', durationSeconds: 4, timeBasis: 'elapsed' });

    for (const source of [online, local]) {
      const loaded = parseRecord(recordJSON(source));
      expect(loaded.schemaVersion).toBe(1);
      expect(loaded.initial).toEqual(opening);
      expect(loaded.initial.actionHistory).toHaveLength(0);
      expect(loaded.moves).toHaveLength(4);
      expect(snapshotState(replayFrame(loaded, 0))).toEqual(opening);
      expect(snapshotState(replayFrame(loaded, 4))).toEqual(snapshotState(match.gameState));
    }
    expect(online.moves).toEqual(local.moves);
    expect(online.final.pieces).toEqual(local.final.pieces);
  });
});
