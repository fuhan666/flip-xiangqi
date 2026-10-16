import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

describe('interaction feedback', () => {
  it('cancels selection when the selected revealed piece is clicked again', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    render(<App initialState={initialState} />);

    const rookCell = screen.getByTestId('cell-0-9');

    await user.click(rookCell);
    expect(rookCell).toHaveAttribute('aria-pressed', 'true');

    await user.click(rookCell);

    expect(rookCell).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('操作提示：已取消选中，请重新选择棋子或翻开暗子')).toBeInTheDocument();
  });

  it('shows guidance when clicking an empty cell without a selected piece', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      ],
    });

    render(<App initialState={initialState} />);

    await user.click(screen.getByTestId('cell-0-0'));

    expect(screen.getByText('操作提示：该格当前不可直接操作，请先选择己方明子或翻开暗子')).toBeInTheDocument();
  });

  it('shows guidance when clicking an opponent piece without a selected piece', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'black-rook', camp: 'black', type: 'rook', position: { x: 0, y: 0 } }),
      ],
    });

    render(<App initialState={initialState} />);

    await user.click(screen.getByTestId('cell-0-0'));

    expect(screen.getByText('操作提示：不能直接操作对方明子，请先选择己方明子')).toBeInTheDocument();
  });

  it('keeps rule-engine errors visible for illegal moves', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    render(<App initialState={initialState} />);

    await user.click(screen.getByTestId('cell-0-0'));
    expect(screen.getByText('操作提示：该格当前不可直接操作，请先选择己方明子或翻开暗子')).toBeInTheDocument();

    await user.click(screen.getByTestId('cell-0-9'));
    await user.click(screen.getByTestId('cell-1-8'));

    expect(screen.getByText('非法操作：车只能直走')).toBeInTheDocument();
    expect(screen.queryByText('操作提示：该格当前不可直接操作，请先选择己方明子或翻开暗子')).not.toBeInTheDocument();
  });

  it('marks legal empty targets and capturable pieces when a revealed piece is selected', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
        piece({ id: 'black-horse', camp: 'black', type: 'horse', position: { x: 0, y: 3 } }),
        piece({ id: 'hidden-black-pawn', camp: 'black', type: 'pawn', position: { x: 0, y: 1 }, revealed: false }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    await user.click(screen.getByTestId('cell-0-9'));

    expect(screen.getByTestId('cell-0-9')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('cell-0-8')).toHaveAttribute('data-legal-move', 'empty');
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-legal-move', 'empty');
    expect(screen.getByTestId('cell-3-9')).toHaveAttribute('data-legal-move', 'empty');
    expect(container.querySelectorAll('.legal-move-empty')).toHaveLength(8);
    expect(screen.getByTestId('cell-0-3')).toHaveAttribute('data-legal-move', 'capture');
    expect(container.querySelectorAll('.legal-move-capture')).toHaveLength(1);
    expect(screen.getByTestId('cell-0-2')).toHaveAttribute('data-legal-move', 'none');
    expect(screen.getByTestId('cell-0-1')).toHaveAttribute('data-legal-move', 'none');
    expect(screen.getByTestId('cell-4-5')).toHaveAttribute('data-legal-move', 'none');
    expect(screen.getByTestId('cell-4-0')).toHaveAttribute('data-legal-move', 'none');
    expect(screen.getByTestId('cell-4-9')).toHaveAttribute('data-legal-move', 'none');
    expect(screen.queryByText(/合法落点|可落子|可移动/)).not.toBeInTheDocument();
  });

  it('clears legal-move hints when the selection is cancelled and after the move is played', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    await user.click(screen.getByTestId('cell-0-9'));
    expect(container.querySelectorAll('.legal-move')).not.toHaveLength(0);

    await user.click(screen.getByTestId('cell-0-9'));
    expect(container.querySelectorAll('.legal-move')).toHaveLength(0);

    await user.click(screen.getByTestId('cell-0-9'));
    await user.click(screen.getByTestId('cell-0-5'));
    expect(container.querySelectorAll('.legal-move')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '悔棋' }));
    expect(container.querySelectorAll('.legal-move')).toHaveLength(0);
  });

  it('keeps every surface desensitized during the first half of the flip and reveals at the midpoint', () => {
    vi.useFakeTimers();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    render(<App initialState={initialState} />);

    fireEvent.click(screen.getByTestId('cell-0-5'));

    const flippingCell = screen.getByTestId('cell-0-5');
    expect(flippingCell).toHaveAttribute('data-cell-state', 'hidden');
    expect(flippingCell).toHaveAttribute('data-flip-phase', 'back');
    expect(flippingCell).toHaveTextContent('暗');
    expect(flippingCell).not.toHaveClass('red');
    expect(flippingCell.querySelector('.piece-face-revealed')).toBeNull();
    expect(screen.getByText('暂无最近一步，先翻牌或移动明子。')).toBeInTheDocument();
    expect(within(screen.getByTestId('status-live-feedback')).getByText('暂无最新变化')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(flippingCell).toHaveAttribute('data-cell-state', 'revealed');
    expect(flippingCell).toHaveAttribute('data-flip-phase', 'front');
    expect(flippingCell).toHaveAttribute('data-recent-action', 'flip');
    expect(flippingCell).toHaveAttribute('data-turn-state', 'opponent');
    expect(flippingCell).toHaveTextContent('俥');

    const liveFeedback = screen.getByTestId('status-live-feedback');
    expect(within(liveFeedback).getByText('即时反馈')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('红方翻开了红方俥')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('位置：第 1 列，第 6 行')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('下一手：黑方')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(flippingCell).toHaveAttribute('data-flip-phase', 'none');
    vi.useRealTimers();
  });
});
