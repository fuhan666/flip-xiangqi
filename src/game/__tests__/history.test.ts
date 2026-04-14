import { describe, expect, it } from 'vitest';
import { applyAction, createEmptyGameState, createInitialGameState, restartGame } from '../index';
import type { GameState, Piece } from '../types';

type HistoryState = GameState & {
  actionHistory?: Array<Record<string, unknown>>;
  recentAction?: Record<string, unknown> | null;
};

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

function stateWithPieces(pieces: Piece[], currentTurn: GameState['currentTurn'] = 'red'): GameState {
  return createEmptyGameState({ pieces, currentTurn });
}

function expectHistoryEntry(state: HistoryState) {
  expect(Array.isArray(state.actionHistory)).toBe(true);
  if (!Array.isArray(state.actionHistory)) {
    throw new Error('actionHistory should be defined');
  }
  expect(state.actionHistory).toHaveLength(1);
  expect(state.recentAction).toEqual(state.actionHistory[0]);
  return state.actionHistory[0];
}

describe('action history', () => {
  it('records successful flips as a recent action entry', () => {
    const state = createInitialGameState(() => 0);
    const hiddenPiece = state.pieces.find((candidate) => !candidate.revealed)!;

    const nextState = applyAction(state, {
      type: 'flip',
      position: hiddenPiece.position!,
    }) as HistoryState;

    const entry = expectHistoryEntry(nextState);
    expect(entry).toMatchObject({
      turnNumber: 1,
      actor: 'red',
      nextTurn: 'black',
      checkedCamp: null,
      winner: null,
    });
    expect(entry.action).toMatchObject({
      type: 'flip',
      position: hiddenPiece.position,
      piece: {
        id: hiddenPiece.id,
        camp: hiddenPiece.camp,
        type: hiddenPiece.type,
      },
    });
    expect(entry.consequences).toEqual([]);
  });

  it('records successful moves with move coordinates', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'file-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
    }) as HistoryState;

    const entry = expectHistoryEntry(nextState);
    expect(entry).toMatchObject({
      turnNumber: 1,
      actor: 'red',
      nextTurn: 'black',
      checkedCamp: null,
      winner: null,
    });
    expect(entry.action).toMatchObject({
      type: 'move',
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
      piece: {
        id: 'red-rook',
        camp: 'red',
        type: 'rook',
      },
    });
    expect(entry.consequences).toEqual([]);
  });

  it('records capture and check as consequences of one move', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 4, y: 5 } }),
      piece({ id: 'black-rook', camp: 'black', type: 'rook', position: { x: 4, y: 3 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 4, y: 5 },
      to: { x: 4, y: 3 },
    }) as HistoryState;

    const entry = expectHistoryEntry(nextState);
    expect(entry).toMatchObject({
      checkedCamp: 'black',
      winner: null,
      nextTurn: 'black',
    });
    expect(entry.consequences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'capture',
          piece: expect.objectContaining({
            id: 'black-rook',
            camp: 'black',
            type: 'rook',
          }),
          position: { x: 4, y: 3 },
        }),
        expect.objectContaining({
          type: 'check',
          camp: 'black',
        }),
      ]),
    );
  });

  it('records a king capture as an endgame consequence', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 4, y: 1 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 4, y: 1 },
      to: { x: 4, y: 0 },
    }) as HistoryState;

    const entry = expectHistoryEntry(nextState);
    expect(entry).toMatchObject({
      winner: 'red',
      nextTurn: null,
    });
    expect(entry.consequences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'capture',
          piece: expect.objectContaining({
            id: 'black-king',
            camp: 'black',
            type: 'king',
          }),
          position: { x: 4, y: 0 },
        }),
        expect.objectContaining({
          type: 'endgame',
          winner: 'red',
          reason: 'king-captured',
        }),
      ]),
    );
  });

  it('records check when a flipped piece reveals an attack', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({
        id: 'hidden-red-rook',
        camp: 'red',
        type: 'rook',
        position: { x: 4, y: 5 },
        revealed: false,
      }),
    ]);

    const nextState = applyAction(state, {
      type: 'flip',
      position: { x: 4, y: 5 },
    }) as HistoryState;

    const entry = expectHistoryEntry(nextState);
    expect(entry).toMatchObject({
      checkedCamp: 'black',
      winner: null,
      nextTurn: 'black',
    });
    expect(entry.consequences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'check',
          camp: 'black',
        }),
      ]),
    );
  });

  it('does not append history for illegal actions', () => {
    const state = stateWithPieces([
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
    ]);

    const nextState = applyAction(state, {
      type: 'move',
      from: { x: 0, y: 0 },
      to: { x: 0, y: 1 },
    }) as HistoryState;

    expect(nextState.lastError).toContain('起点没有棋子');
    expect(nextState.actionHistory ?? []).toHaveLength(0);
    expect(nextState.recentAction ?? null).toBeNull();
  });

  it('starts and restarts games with empty history', () => {
    const initialState = createInitialGameState(() => 0) as HistoryState;
    expect(initialState.actionHistory ?? []).toHaveLength(0);
    expect(initialState.recentAction ?? null).toBeNull();

    const hiddenPiece = initialState.pieces.find((candidate) => !candidate.revealed)!;
    const progressedState = applyAction(initialState, {
      type: 'flip',
      position: hiddenPiece.position!,
    }) as HistoryState;
    const restartedState = restartGame(() => 0) as HistoryState;

    expect((progressedState.actionHistory ?? []).length).toBeGreaterThan(0);
    expect(restartedState.actionHistory ?? []).toHaveLength(0);
    expect(restartedState.recentAction ?? null).toBeNull();
  });
});
