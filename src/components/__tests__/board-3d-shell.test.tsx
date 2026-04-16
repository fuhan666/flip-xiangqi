import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyGameState } from '../../game';
import { Board } from '../Board';
import type { Piece } from '../../game/types';

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

vi.mock('../three/BoardScene', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../three/BoardScene')>();
  return {
    ...mod,
    isTestEnvironment: vi.fn(),
  };
});

import { isTestEnvironment } from '../three/BoardScene';

describe('Board 3D shell', () => {
  it('renders a 3D stage while keeping semantic cell controls for interaction in test env', () => {
    const mockIsTestEnvironment = vi.mocked(isTestEnvironment);
    mockIsTestEnvironment.mockReturnValue(true);

    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    render(<Board gameState={gameState} selectedPosition={{ x: 0, y: 9 }} onCellClick={vi.fn()} />);

    expect(screen.getByText('3D 主视图')).toBeInTheDocument();
    expect(screen.getByText('棋盘、棋子与交互已全面迁移至 Three.js 3D 场景。')).toBeInTheDocument();
    expect(screen.getByLabelText('翻牌中国象棋棋盘 3D 视图')).toBeInTheDocument();
    expect(screen.getByText('已启用 3D 棋盘静态回退视图。')).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: '翻牌中国象棋棋盘' })).toBeInTheDocument();
    expect(screen.getByTestId('cell-0-9')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('cell-0-9')).toHaveTextContent('俥');
  });

  it('does not render the 2D auxiliary board grid in production (non-test environment)', () => {
    const mockIsTestEnvironment = vi.mocked(isTestEnvironment);
    mockIsTestEnvironment.mockReturnValue(false);

    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    const { container } = render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);

    expect(screen.queryByRole('grid', { name: '翻牌中国象棋棋盘' })).not.toBeInTheDocument();
    expect(container.querySelector('.board')).toBeNull();
    expect(screen.queryByTestId('cell-0-9')).not.toBeInTheDocument();
    expect(screen.getByLabelText('翻牌中国象棋棋盘 3D 视图')).toBeInTheDocument();
  });

  it('shows the current turn, board legend, and cell-state hooks for board readability', () => {
    const mockIsTestEnvironment = vi.mocked(isTestEnvironment);
    mockIsTestEnvironment.mockReturnValue(true);

    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'hidden-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
        piece({ id: 'black-rook', camp: 'black', type: 'rook', position: { x: 1, y: 5 } }),
        piece({ id: 'red-pawn', camp: 'red', type: 'pawn', position: { x: 2, y: 5 } }),
      ],
    });

    render(<Board gameState={gameState} selectedPosition={{ x: 2, y: 5 }} onCellClick={vi.fn()} />);

    expect(screen.getByText('红方回合')).toBeInTheDocument();
    expect(screen.getByLabelText('棋盘状态说明')).toHaveTextContent('暗子');
    expect(screen.getByLabelText('棋盘状态说明')).toHaveTextContent('己方明子');
    expect(screen.getByLabelText('棋盘状态说明')).toHaveTextContent('对方明子');
    expect(screen.getByLabelText('棋盘状态说明')).toHaveTextContent('当前选中');
    expect(screen.getByLabelText('棋盘状态说明')).toHaveTextContent('最近动作');

    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-cell-state', 'hidden');
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-turn-state', 'neutral');
    expect(screen.getByTestId('cell-1-5')).toHaveAttribute('data-cell-state', 'revealed');
    expect(screen.getByTestId('cell-1-5')).toHaveAttribute('data-turn-state', 'opponent');
    expect(screen.getByTestId('cell-2-5')).toHaveAttribute('data-cell-state', 'revealed');
    expect(screen.getByTestId('cell-2-5')).toHaveAttribute('data-turn-state', 'active');
    expect(screen.getByTestId('cell-2-5')).toHaveAttribute('data-recent-action', 'none');
  });
});
