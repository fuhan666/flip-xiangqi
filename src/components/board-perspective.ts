import { BOARD_HEIGHT, BOARD_WIDTH } from '../game';
import type { Camp, Position } from '../game';

export type Perspective = Camp;

/**
 * 逻辑坐标转显示坐标：
 * - 红方视角（标准）：逻辑坐标即显示坐标；
 * - 黑方视角（己方在下）：相对于棋盘中心进行 180° 对称投影，
 *   displayX = 8 - logicalX
 *   displayY = 9 - logicalY
 */
export function logicalToDisplay(position: Position, perspective: Perspective = 'red'): Position {
  if (perspective === 'black') {
    return {
      x: BOARD_WIDTH - 1 - position.x,
      y: BOARD_HEIGHT - 1 - position.y,
    };
  }

  return { x: position.x, y: position.y };
}

/**
 * 显示坐标（屏幕点击/按键）逆映射回内部权威逻辑坐标：
 * - 红方视角：逻辑坐标等于显示坐标；
 * - 黑方视角：
 *   logicalX = 8 - displayX
 *   logicalY = 9 - displayY
 */
export function displayToLogical(display: Position, perspective: Perspective = 'red'): Position {
  if (perspective === 'black') {
    return {
      x: BOARD_WIDTH - 1 - display.x,
      y: BOARD_HEIGHT - 1 - display.y,
    };
  }

  return { x: display.x, y: display.y };
}
