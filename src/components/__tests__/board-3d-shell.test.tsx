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

describe('Board 3D shell', () => {
  it('renders a 3D stage while keeping semantic cell controls for interaction', () => {
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    render(<Board gameState={gameState} selectedPosition={{ x: 0, y: 9 }} onCellClick={vi.fn()} />);

    expect(screen.getByText('3D Beta')).toBeInTheDocument();
    expect(screen.getByText('保留语义点击棋盘，Three.js 场景按需懒加载以降低首屏阻塞。')).toBeInTheDocument();
    expect(screen.getByLabelText('翻牌中国象棋棋盘 3D 视图')).toBeInTheDocument();
    expect(screen.getByText('已启用 3D 棋盘静态回退视图。')).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: '翻牌中国象棋棋盘' })).toBeInTheDocument();
    expect(screen.getByTestId('cell-0-9')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('cell-0-9')).toHaveTextContent('俥');
  });
});
