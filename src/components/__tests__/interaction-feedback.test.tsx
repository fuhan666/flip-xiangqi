import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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

  it('does not render legal-move highlights when a piece is selected', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    await user.click(screen.getByTestId('cell-0-9'));

    expect(screen.getByTestId('cell-0-9')).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.legal-move')).toBeNull();
    expect(screen.queryByText(/合法落点|可落子|可移动/)).not.toBeInTheDocument();
  });

  it('surfaces flip feedback in the status panel and marks the flipped cell as the latest action', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    render(<App initialState={initialState} />);

    await user.click(screen.getByTestId('cell-0-5'));

    const liveFeedback = screen.getByTestId('status-live-feedback');
    expect(within(liveFeedback).getByText('即时反馈')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('红方翻开了红方俥')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('位置：第 1 列，第 6 行')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('下一手：黑方')).toBeInTheDocument();
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-recent-action', 'flip');
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-turn-state', 'opponent');
  });
});
