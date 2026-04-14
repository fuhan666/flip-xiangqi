import { describe, expect, it } from 'vitest';
import { BOARD_HEIGHT, BOARD_WIDTH, INITIAL_REVEALED_POSITIONS } from '../constants';
import { createInitialGameState } from '../index';

describe('game state creation', () => {
  it('creates a 9x10 board with 32 pieces and only both kings revealed', () => {
    const state = createInitialGameState(() => 0.123456);

    expect(BOARD_WIDTH).toBe(9);
    expect(BOARD_HEIGHT).toBe(10);
    expect(state.pieces).toHaveLength(32);
    expect(state.currentTurn).toBe('red');
    expect(state.winner).toBeNull();

    const revealed = state.pieces.filter((piece) => piece.revealed);
    expect(revealed).toHaveLength(2);
    expect(revealed.map((piece) => piece.position)).toEqual(
      expect.arrayContaining([...INITIAL_REVEALED_POSITIONS]),
    );
  });
});
