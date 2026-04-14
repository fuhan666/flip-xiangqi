import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../../App';
import { createEmptyGameState } from '../../game';
import type { GameHistoryEntry } from '../../game';
import type { Piece } from '../../game/types';

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

describe('app flow', () => {
  it('supports selecting and moving a piece, then restarting the match', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    render(<App initialState={initialState} />);

    expect(screen.getByText('暂无最近一步，先翻牌或移动明子。')).toBeInTheDocument();

    await user.click(screen.getByTestId('cell-0-9'));
    await user.click(screen.getByTestId('cell-0-5'));

    expect(screen.getByTestId('cell-0-5')).toHaveTextContent('俥');
    expect(screen.getByText('红方移动红方俥')).toBeInTheDocument();
    expect(screen.getByText('路线：第 1 列，第 10 行 -> 第 1 列，第 6 行')).toBeInTheDocument();
    expect(screen.getByText('当前回合')).toBeInTheDocument();
    expect(screen.getByText('黑方')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重新开局' }));

    expect(screen.getByText('暂无最近一步，先翻牌或移动明子。')).toBeInTheDocument();
    expect(screen.getByText('红方')).toBeInTheDocument();
  });

  it('undoes the last move from the control panel and clears the current selection', async () => {
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
    const view = within(container);
    const undoButton = view.getByRole('button', { name: '悔棋' });
    expect(undoButton).toBeDisabled();

    await user.click(view.getByTestId('cell-0-9'));
    await user.click(view.getByTestId('cell-0-5'));

    expect(view.getByTestId('cell-0-5')).toHaveTextContent('俥');
    expect(view.getByText('当前回合')).toBeInTheDocument();
    expect(view.getByText('黑方')).toBeInTheDocument();
    expect(undoButton).toBeEnabled();

    const blackKingCell = view.getByTestId('cell-4-0');
    await user.click(blackKingCell);
    expect(blackKingCell).toHaveClass('selected');

    await user.click(undoButton);

    expect(view.getByTestId('cell-0-9')).toHaveTextContent('俥');
    expect(view.getByTestId('cell-0-5')).not.toHaveTextContent('俥');
    expect(view.getByText('红方')).toBeInTheDocument();
    expect(blackKingCell).not.toHaveClass('selected');
    expect(undoButton).toBeDisabled();
  });

  it('does not expose hidden piece faction styling before a piece is flipped', () => {
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
        piece({ id: 'hidden-black-horse', camp: 'black', type: 'horse', position: { x: 1, y: 5 }, revealed: false }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);
    const board = within(container);
    const hiddenRedCell = board.getByTestId('cell-0-5');
    const hiddenBlackCell = board.getByTestId('cell-1-5');

    expect(hiddenRedCell).toHaveTextContent('暗');
    expect(hiddenRedCell).toHaveClass('hidden');
    expect(hiddenRedCell).not.toHaveClass('red');
    expect(hiddenBlackCell).toHaveTextContent('暗');
    expect(hiddenBlackCell).toHaveClass('hidden');
    expect(hiddenBlackCell).not.toHaveClass('black');
  });

  it('shows endgame, check, and illegal-action states without collapsing them into one line', () => {
    const recentAction: GameHistoryEntry = {
      turnNumber: 12,
      actor: 'red',
      action: {
        type: 'move',
        from: { x: 4, y: 1 },
        to: { x: 4, y: 0 },
        piece: {
          id: 'red-rook',
          camp: 'red',
          type: 'rook',
          position: { x: 4, y: 1 },
        },
      },
      consequences: [
        {
          type: 'capture',
          piece: {
            id: 'black-king',
            camp: 'black',
            type: 'king',
            position: { x: 4, y: 0 },
          },
          position: { x: 4, y: 0 },
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
      nextTurn: null,
      checkedCamp: 'black',
      winner: 'red',
      statusMessage: '红方将死对手，获得胜利',
    };

    const initialState = createEmptyGameState({
      currentTurn: 'black',
      winner: 'red',
      checkedCamp: 'black',
      lastError: '对局已经结束，请重新开局',
      statusMessage: '红方将死对手，获得胜利',
      recentAction,
      actionHistory: [recentAction],
    });

    const { container } = render(<App initialState={initialState} />);
    const app = within(container);

    expect(app.getByText('当前回合')).toBeInTheDocument();
    expect(app.getByText('对局结束')).toBeInTheDocument();
    expect(app.getByText('局面')).toBeInTheDocument();
    expect(app.getByText('红方将死对手，获得胜利')).toBeInTheDocument();
    expect(app.getByText('将军')).toBeInTheDocument();
    expect(app.getByText('黑方被将军')).toBeInTheDocument();
    expect(app.getByText('终局')).toBeInTheDocument();
    expect(app.getByText('红方胜利')).toBeInTheDocument();
    expect(app.getByText('非法操作：对局已经结束，请重新开局')).toBeInTheDocument();
  });
});
