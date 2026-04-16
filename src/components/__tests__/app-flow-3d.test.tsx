import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { createEmptyGameState } from '../../game';
import type { Piece } from '../../game/types';

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

// Mock BoardScene so we can simulate the 3D canvas callback path without dealing with lazy loading in jsdom.
vi.mock('../three/BoardScene', () => ({
  BoardScene: vi.fn(({ onCellClick }: { onCellClick?: (position: { x: number; y: number }) => void }) => (
    <div aria-label="翻牌中国象棋棋盘 3D 视图" className="board-stage" data-testid="mock-board-scene" role="img">
      <button data-testid="mock-flip-0-5" onClick={() => onCellClick?.({ x: 0, y: 5 })} type="button">
        Flip 0,5
      </button>
      <button data-testid="mock-select-0-9" onClick={() => onCellClick?.({ x: 0, y: 9 })} type="button">
        Select 0,9
      </button>
      <button data-testid="mock-move-0-8" onClick={() => onCellClick?.({ x: 0, y: 8 })} type="button">
        Move to 0,8
      </button>
      <button data-testid="mock-empty-0-0" onClick={() => onCellClick?.({ x: 0, y: 0 })} type="button">
        Empty 0,0
      </button>
    </div>
  )),
  isTestEnvironment: vi.fn().mockReturnValue(false),
}));

describe('app flow through 3D scene path (production)', () => {
  it('flips a hidden piece via the 3D scene callback without the 2D grid present', async () => {
    const user = userEvent.setup();

    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        // Blocker between kings to avoid facing-kings violation on flip
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    render(<App initialState={initialState} />);

    // 2D grid must not be present in production
    expect(screen.queryByRole('grid', { name: '翻牌中国象棋棋盘' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('cell-0-5')).not.toBeInTheDocument();

    // 3D scene wrapper must be present
    expect(screen.getByLabelText('翻牌中国象棋棋盘 3D 视图')).toBeInTheDocument();
    expect(screen.getByTestId('mock-board-scene')).toBeInTheDocument();

    // Trigger flip through the 3D scene callback
    await user.click(screen.getByTestId('mock-flip-0-5'));

    const liveFeedback = screen.getByTestId('status-live-feedback');
    expect(within(liveFeedback).getByText('红方翻开了红方俥')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('位置：第 1 列，第 6 行')).toBeInTheDocument();
    expect(screen.getByText('黑方回合')).toBeInTheDocument();
  });

  it('selects and moves a piece via the 3D scene callback without the 2D grid present', async () => {
    const user = userEvent.setup();

    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        // Blocker between kings to avoid facing-kings violation
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    render(<App initialState={initialState} />);

    expect(screen.queryByRole('grid', { name: '翻牌中国象棋棋盘' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-board-scene')).toBeInTheDocument();

    // Select own piece
    await user.click(screen.getByTestId('mock-select-0-9'));
    expect(screen.queryByText('操作提示')).not.toBeInTheDocument();

    // Move it
    await user.click(screen.getByTestId('mock-move-0-8'));

    const liveFeedback = screen.getByTestId('status-live-feedback');
    expect(within(liveFeedback).getByText('刚刚走子')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('落点：第 1 列，第 9 行')).toBeInTheDocument();
    expect(screen.getByText('黑方回合')).toBeInTheDocument();
  });

  it('surfaces interaction guidance through the 3D scene path when clicking an empty cell', async () => {
    const user = userEvent.setup();

    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      ],
    });

    render(<App initialState={initialState} />);

    expect(screen.queryByRole('grid', { name: '翻牌中国象棋棋盘' })).not.toBeInTheDocument();

    // Mock an empty-cell click through the 3D callback
    await user.click(screen.getByTestId('mock-empty-0-0'));

    expect(screen.getByText('操作提示：该格当前不可直接操作，请先选择己方明子或翻开暗子')).toBeInTheDocument();
  });
});
