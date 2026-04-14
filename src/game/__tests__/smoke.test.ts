import { describe, expect, it } from 'vitest';
import { createInitialGameState } from '../index';

describe('game engine smoke test', () => {
  it('exports an initial state factory', () => {
    expect(createInitialGameState).toBeTypeOf('function');
  });
});
