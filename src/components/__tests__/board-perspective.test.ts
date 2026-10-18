import { describe, expect, it } from 'vitest';
import { BOARD_HEIGHT, BOARD_WIDTH } from '../../game';
import { displayToLogical, logicalToDisplay } from '../board-perspective';

describe('board-perspective coordinate mappings', () => {
  it('preserves coordinates identically under red perspective', () => {
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      for (let x = 0; x < BOARD_WIDTH; x += 1) {
        const pos = { x, y };
        const disp = logicalToDisplay(pos, 'red');
        expect(disp).toEqual(pos);
        expect(displayToLogical(disp, 'red')).toEqual(pos);
      }
    }
  });

  it('guarantees round-trip identity for all 90 grid intersections under black perspective', () => {
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      for (let x = 0; x < BOARD_WIDTH; x += 1) {
        const pos = { x, y };
        const disp = logicalToDisplay(pos, 'black');
        expect(disp.x).toBeGreaterThanOrEqual(0);
        expect(disp.x).toBeLessThan(BOARD_WIDTH);
        expect(disp.y).toBeGreaterThanOrEqual(0);
        expect(disp.y).toBeLessThan(BOARD_HEIGHT);

        const restored = displayToLogical(disp, 'black');
        expect(restored).toEqual(pos);
      }
    }
  });

  it('maintains a one-to-one bijective mapping across all 90 cells', () => {
    const seenRed = new Set<string>();
    const seenBlack = new Set<string>();

    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      for (let x = 0; x < BOARD_WIDTH; x += 1) {
        const pos = { x, y };
        const redDisp = logicalToDisplay(pos, 'red');
        const blackDisp = logicalToDisplay(pos, 'black');

        seenRed.add(`${redDisp.x},${redDisp.y}`);
        seenBlack.add(`${blackDisp.x},${blackDisp.y}`);
      }
    }

    expect(seenRed.size).toBe(90);
    expect(seenBlack.size).toBe(90);
  });

  it('correctly maps the four corner intersections', () => {
    expect(logicalToDisplay({ x: 0, y: 0 }, 'black')).toEqual({ x: 8, y: 9 });
    expect(logicalToDisplay({ x: 8, y: 0 }, 'black')).toEqual({ x: 0, y: 9 });
    expect(logicalToDisplay({ x: 0, y: 9 }, 'black')).toEqual({ x: 8, y: 0 });
    expect(logicalToDisplay({ x: 8, y: 9 }, 'black')).toEqual({ x: 0, y: 0 });
  });

  it('places Red King and Black King at the respective bottom seats', () => {
    const redKingPos = { x: 4, y: 9 };
    const blackKingPos = { x: 4, y: 0 };

    // 红方视角：红帅在下（y=9），黑将在上（y=0）
    expect(logicalToDisplay(redKingPos, 'red')).toEqual({ x: 4, y: 9 });
    expect(logicalToDisplay(blackKingPos, 'red')).toEqual({ x: 4, y: 0 });

    // 黑方视角：黑将在下（display y=9），红帅在上（display y=0）
    expect(logicalToDisplay(blackKingPos, 'black')).toEqual({ x: 4, y: 9 });
    expect(logicalToDisplay(redKingPos, 'black')).toEqual({ x: 4, y: 0 });
  });

  it('correctly rotates asymmetric cannon and soldier points', () => {
    // 炮位
    expect(logicalToDisplay({ x: 1, y: 2 }, 'black')).toEqual({ x: 7, y: 7 });
    expect(logicalToDisplay({ x: 7, y: 2 }, 'black')).toEqual({ x: 1, y: 7 });
    expect(logicalToDisplay({ x: 1, y: 7 }, 'black')).toEqual({ x: 7, y: 2 });
    expect(logicalToDisplay({ x: 7, y: 7 }, 'black')).toEqual({ x: 1, y: 2 });

    // 兵/卒位
    expect(logicalToDisplay({ x: 0, y: 3 }, 'black')).toEqual({ x: 8, y: 6 });
    expect(logicalToDisplay({ x: 8, y: 3 }, 'black')).toEqual({ x: 0, y: 6 });
    expect(logicalToDisplay({ x: 0, y: 6 }, 'black')).toEqual({ x: 8, y: 3 });
    expect(logicalToDisplay({ x: 8, y: 6 }, 'black')).toEqual({ x: 0, y: 3 });

    // 走子轨迹映射测试（复用种子 42 验证基准）
    // 红炮从 (0,6) 移动到 (0,0) 在黑方视角下起点为 (8,3)，终点为 (8,9)
    expect(logicalToDisplay({ x: 0, y: 6 }, 'black')).toEqual({ x: 8, y: 3 });
    expect(logicalToDisplay({ x: 0, y: 0 }, 'black')).toEqual({ x: 8, y: 9 });
  });
});
