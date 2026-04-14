import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MoveHistory } from '../MoveHistory';
import type { GameHistoryEntry } from '../../game';

function createHistoryEntry(overrides: Partial<GameHistoryEntry> = {}): GameHistoryEntry {
  return {
    turnNumber: 1,
    actor: 'red',
    action: {
      type: 'move',
      from: { x: 0, y: 9 },
      to: { x: 0, y: 5 },
      piece: {
        id: 'red-rook',
        camp: 'red',
        type: 'rook',
        position: { x: 0, y: 9 },
      },
    },
    consequences: [],
    nextTurn: 'black',
    checkedCamp: null,
    winner: null,
    statusMessage: '黑方行动',
    ...overrides,
  };
}

describe('MoveHistory', () => {
  it('shows an empty state before any action is recorded', () => {
    render(<MoveHistory recentAction={null} />);

    expect(screen.getByRole('heading', { name: '最近一步' })).toBeInTheDocument();
    expect(screen.getByText('暂无最近一步，先翻牌或移动明子。')).toBeInTheDocument();
  });

  it('summarizes a flip action with the revealed piece and next turn', () => {
    render(
      <MoveHistory
        recentAction={createHistoryEntry({
          action: {
            type: 'flip',
            position: { x: 0, y: 0 },
            piece: {
              id: 'black-rook',
              camp: 'black',
              type: 'rook',
              position: { x: 0, y: 0 },
            },
          },
          statusMessage: '黑方行动',
        })}
      />,
    );

    expect(screen.getByText('第 1 手')).toBeInTheDocument();
    expect(screen.getByText('红方翻开了黑方車')).toBeInTheDocument();
    expect(screen.getByText('位置：第 1 列，第 1 行')).toBeInTheDocument();
    expect(screen.getByText('下一手：黑方')).toBeInTheDocument();
  });

  it('lists capture, check, and endgame consequences for the recent action', () => {
    render(
      <MoveHistory
        recentAction={createHistoryEntry({
          winner: 'red',
          nextTurn: null,
          checkedCamp: 'black',
          statusMessage: '红方将死对手，获得胜利',
          consequences: [
            {
              type: 'capture',
              piece: {
                id: 'black-rook',
                camp: 'black',
                type: 'rook',
                position: { x: 0, y: 5 },
              },
              position: { x: 0, y: 5 },
            },
            {
              type: 'check',
              camp: 'black',
            },
            {
              type: 'endgame',
              winner: 'red',
              reason: 'checkmate',
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('红方移动红方俥')).toBeInTheDocument();
    expect(screen.getByText('路线：第 1 列，第 10 行 -> 第 1 列，第 6 行')).toBeInTheDocument();
    expect(screen.getByText('结果：吃掉黑方車')).toBeInTheDocument();
    expect(screen.getByText('结果：黑方被将军')).toBeInTheDocument();
    expect(screen.getByText('结果：红方胜利（将死）')).toBeInTheDocument();
    expect(screen.getByText('下一手：对局结束')).toBeInTheDocument();
  });
});
