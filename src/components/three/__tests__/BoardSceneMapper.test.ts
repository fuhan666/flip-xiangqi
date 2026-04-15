import { describe, expect, it } from 'vitest';
import { createEmptyGameState } from '../../../game';
import { mapBoardSceneModel, SCENE_CELL_SIZE } from '../boardSceneMapper';
import type { Piece } from '../../../game/types';

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

describe('mapBoardSceneModel', () => {
  it('projects board cells and active pieces into scene coordinates without leaking hidden camp styling', () => {
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 6 }, revealed: false }),
        piece({ id: 'captured-black-horse', camp: 'black', type: 'horse', position: null, captured: true }),
      ],
    });

    const model = mapBoardSceneModel(gameState, { x: 0, y: 6 });
    const hiddenCell = model.cells.find((cell) => cell.key === '0-6');
    const redKing = model.pieces.find((entry) => entry.id === 'red-king');
    const blackKing = model.pieces.find((entry) => entry.id === 'black-king');
    const hiddenRook = model.pieces.find((entry) => entry.id === 'hidden-red-rook');

    expect(model.cells).toHaveLength(90);
    expect(model.pieces).toHaveLength(3);
    expect(hiddenCell).toMatchObject({
      isFaceDown: true,
      isSelected: true,
      pieceCamp: null,
      pieceLabel: '暗',
      worldX: -4 * SCENE_CELL_SIZE,
    });
    expect(redKing?.worldX).toBeCloseTo(0);
    expect(redKing?.worldZ).toBeLessThan(0);
    expect(blackKing?.worldX).toBeCloseTo(0);
    expect(blackKing?.worldZ).toBeGreaterThan(0);
    expect(hiddenRook).toMatchObject({
      isHidden: true,
      isSelected: true,
      label: '暗',
      worldZ: -1.5 * SCENE_CELL_SIZE,
    });
  });
});
