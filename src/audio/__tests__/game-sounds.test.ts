import { describe, expect, it } from 'vitest';
import type {
  Camp,
  GameHistoryConsequence,
  GameHistoryEntry,
  HistoryPieceSnapshot,
  PieceType,
} from '../../game/types';
import {
  baseSoundForEntry,
  hasCaptureConsequence,
  hasCheckConsequence,
  hasEndgameConsequence,
  soundCuesForHistoryEntry,
  soundCuesForMatchEnd,
} from '../game-sounds';

const PAWN: HistoryPieceSnapshot = {
  id: 'red-pawn-1',
  camp: 'red',
  type: 'pawn' as PieceType,
  position: { x: 0, y: 0 },
};

function entry(overrides: Partial<GameHistoryEntry> = {}): GameHistoryEntry {
  return {
    stepNumber: 1,
    turnNumber: 1,
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

const CAPTURE: GameHistoryConsequence = {
  type: 'capture',
  piece: { ...PAWN, id: 'black-pawn-1', camp: 'black' as Camp },
  position: { x: 0, y: 5 },
};

const CHECK: GameHistoryConsequence = { type: 'check', camp: 'black' as Camp };

const ENDGAME: GameHistoryConsequence = {
  type: 'endgame',
  winner: 'red' as Camp,
  reason: 'checkmate',
};

describe('game action sound mapping', () => {
  it('maps each action kind to exactly one base sound', () => {
    expect(
      baseSoundForEntry(
        entry({
          kind: 'flip',
          action: { type: 'flip', position: { x: 3, y: 4 }, piece: PAWN },
        }),
      ),
    ).toBe('flip');

    expect(baseSoundForEntry(entry())).toBe('move');

    expect(baseSoundForEntry(entry({ kind: 'capture', consequences: [CAPTURE] }))).toBe('capture');
  });

  it('exposes the consequences the cue resolution depends on', () => {
    const entryWithEverything = entry({ consequences: [CAPTURE, CHECK, ENDGAME], winner: 'red' });
    expect(hasCaptureConsequence(entryWithEverything)).toBe(true);
    expect(hasCheckConsequence(entryWithEverything)).toBe(true);
    expect(hasEndgameConsequence(entryWithEverything)).toBe(true);
    expect(hasCheckConsequence(entry())).toBe(false);
  });

  it('adds the check cue on top of the base sound', () => {
    expect(soundCuesForHistoryEntry(entry({ consequences: [CHECK] }), { endsGame: false })).toEqual([
      'move',
      'check',
    ]);
  });

  it('replaces the move sound with the capture sound', () => {
    expect(soundCuesForHistoryEntry(entry({ consequences: [CAPTURE] }), { endsGame: false })).toEqual([
      'capture',
    ]);
  });

  it('prefers the victory cue over the check cue when the game ends', () => {
    expect(
      soundCuesForHistoryEntry(entry({ consequences: [CAPTURE, CHECK, ENDGAME], winner: 'red' }), {
        endsGame: true,
      }),
    ).toEqual(['capture', 'victory']);

    expect(
      soundCuesForHistoryEntry(entry({ consequences: [CHECK], winner: 'red' }), { endsGame: true }),
    ).toEqual(['move', 'victory']);
  });

  it('keeps flips silent about the hidden piece identity', () => {
    expect(
      soundCuesForHistoryEntry(
        entry({
          kind: 'flip',
          action: { type: 'flip', position: { x: 3, y: 4 }, piece: PAWN },
        }),
        { endsGame: false },
      ),
    ).toEqual(['flip']);
  });

  it('plays only the victory phrase when a match ends without a board action', () => {
    expect(soundCuesForMatchEnd()).toEqual(['victory']);
  });
});
