import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { applyAction, createEmptyGameState } from '../../game';
import type { GameHistoryEntry, GameState } from '../../game';
import type { Piece } from '../../game/types';

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

function createFinishedGameState(overrides: Partial<GameState> = {}): GameState {
  const recentAction: GameHistoryEntry = {
    stepNumber: 12,
    turnNumber: 12,
    kind: 'capture',
    actor: 'red',
    durationSeconds: null,
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

  return createEmptyGameState({
    currentTurn: 'black',
    winner: 'red',
    checkedCamp: 'black',
    lastError: '对局已经结束，请重新开局',
    statusMessage: '红方将死对手，获得胜利',
    recentAction,
    actionHistory: [recentAction],
    ...overrides,
  });
}

function createUndoableFinishedGameState(): GameState {
  const startingState = createEmptyGameState({
    pieces: [
      piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 4, y: 1 } }),
    ],
  });

  return applyAction(startingState, {
    type: 'move',
    from: { x: 4, y: 1 },
    to: { x: 4, y: 0 },
  });
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

    const liveFeedback = screen.getByTestId('status-live-feedback');
    expect(within(liveFeedback).getByText('刚刚走子')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('落点：第 1 列，第 6 行')).toBeInTheDocument();

    expect(screen.getByText('当前回合')).toBeInTheDocument();
    expect(screen.getByText('黑方')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重新随机开局' }));

    expect(screen.getByText('暂无最近一步，先翻牌或移动明子。')).toBeInTheDocument();
    expect(screen.getByText('红方')).toBeInTheDocument();
    expect(screen.queryByText('最近结果')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: '本局结果' })).not.toBeInTheDocument();
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
    expect(view.getByTestId('cell-0-9')).toHaveAttribute('data-recent-action', 'move-from');
    expect(view.getByTestId('cell-0-5')).toHaveAttribute('data-recent-action', 'move-to');
    expect(view.getByTestId('cell-0-5')).toHaveAttribute('data-turn-state', 'opponent');
    expect(view.getByText('当前回合')).toBeInTheDocument();
    expect(view.getByText('黑方')).toBeInTheDocument();
    expect(undoButton).toBeEnabled();

    const blackKingCell = view.getByTestId('cell-4-0');
    await user.click(blackKingCell);
    expect(blackKingCell).toHaveClass('selected');

    await user.click(undoButton);

    expect(view.getByTestId('cell-0-9')).toHaveTextContent('俥');
    expect(view.getByTestId('cell-0-5')).not.toHaveTextContent('俥');
    expect(view.getByTestId('cell-0-9')).toHaveAttribute('data-recent-action', 'none');
    expect(view.getByTestId('cell-0-9')).toHaveAttribute('data-turn-state', 'active');
    expect(view.getByTestId('cell-0-5')).toHaveAttribute('data-recent-action', 'none');
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
    const initialState = createFinishedGameState();

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

  it('shows an endgame summary and archives it after starting the next match', async () => {
    const user = userEvent.setup();
    const { container } = render(<App initialState={createFinishedGameState()} />);
    const app = within(container);

    expect(app.getByRole('heading', { level: 3, name: '本局结果' })).toBeInTheDocument();
    expect(app.getAllByText('结束方式')).not.toHaveLength(0);
    expect(app.getAllByText('将死获胜')).not.toHaveLength(0);
    expect(app.getAllByText('最近一步')).not.toHaveLength(0);
    expect(app.getAllByText('红方移动红方俥')).not.toHaveLength(0);

    await user.click(app.getByRole('button', { name: '再来一局' }));

    expect(app.queryByRole('heading', { level: 3, name: '本局结果' })).not.toBeInTheDocument();
    expect(app.getAllByText('最近结果')).not.toHaveLength(0);
    expect(app.getAllByText('红方获胜（将死获胜）')).not.toHaveLength(0);
  });

  it('returns to an in-progress view when undoing from a finished game', async () => {
    const user = userEvent.setup();
    const { container } = render(<App initialState={createUndoableFinishedGameState()} />);
    const app = within(container);

    expect(app.getByRole('heading', { level: 3, name: '本局结果' })).toBeInTheDocument();
    expect(app.getByRole('button', { name: '再来一局' })).toBeInTheDocument();
    expect(app.getByRole('button', { name: '悔棋' })).toBeEnabled();

    await user.click(app.getByRole('button', { name: '悔棋' }));

    expect(app.queryByRole('heading', { level: 3, name: '本局结果' })).not.toBeInTheDocument();
    expect(app.queryByRole('button', { name: '再来一局' })).not.toBeInTheDocument();
    expect(app.queryByText('最近结果')).not.toBeInTheDocument();
    expect(app.getByText('当前回合')).toBeInTheDocument();
    expect(app.getByText('红方')).toBeInTheDocument();
    expect(app.getByTestId('cell-4-1')).toHaveTextContent('俥');
    expect(app.getByTestId('cell-4-0')).toHaveTextContent('将');
  });

  it('plays the mating move from an ongoing game and settles the checkmate result', async () => {
    const user = userEvent.setup();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 3, y: 2 } }),
        piece({ id: 'red-pawn-left', camp: 'red', type: 'pawn', position: { x: 3, y: 1 } }),
        piece({ id: 'red-pawn-right', camp: 'red', type: 'pawn', position: { x: 5, y: 1 } }),
        piece({ id: 'red-pawn-center', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-red-pawn', camp: 'red', type: 'pawn', position: { x: 0, y: 6 }, revealed: false }),
        piece({ id: 'black-horse-1', camp: 'black', type: 'horse', position: null, captured: true }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);
    const app = within(container);

    await user.click(app.getByTestId('cell-3-2'));
    await user.click(app.getByTestId('cell-4-2'));

    expect(app.getByTestId('cell-4-2')).toHaveTextContent('俥');
    expect(app.getByTestId('cell-4-0')).toHaveTextContent('将');
    expect(app.getByText('黑方阵亡：馬')).toBeInTheDocument();

    const summary = app
      .getByRole('heading', { level: 3, name: '本局结果' })
      .closest('.status-summary-card') as HTMLElement;
    expect(within(summary).getByText('结束方式')).toBeInTheDocument();
    expect(within(summary).getByText('将死获胜')).toBeInTheDocument();
    expect(within(summary).getByText('红方获胜')).toBeInTheDocument();

    expect(app.getByText('当前回合')).toBeInTheDocument();
    expect(app.getByText('对局结束')).toBeInTheDocument();
    expect(app.getByText('红方将死对手，获得胜利')).toBeInTheDocument();
    expect(app.getByText('黑方被将军')).toBeInTheDocument();
    expect(app.getByText('红方胜利')).toBeInTheDocument();

    expect(app.getByText('第 1 手')).toBeInTheDocument();
    expect(app.getAllByText('红方移动红方俥')).not.toHaveLength(0);
    expect(app.getByText('结果：红方胜利（将死）')).toBeInTheDocument();

    const liveFeedback = app.getByTestId('status-live-feedback');
    expect(within(liveFeedback).getByText('刚刚完成制胜一手')).toBeInTheDocument();
    expect(within(liveFeedback).getByText('红方获胜（将死获胜）')).toBeInTheDocument();

    await user.click(app.getByTestId('cell-0-6'));
    expect(app.getByText('非法操作：对局已经结束，请重新开局')).toBeInTheDocument();
    expect(app.getByText('第 1 手')).toBeInTheDocument();
    expect(app.getByText('对局结束')).toBeInTheDocument();
    expect(app.getByTestId('cell-4-2')).toHaveTextContent('俥');

    await user.click(app.getByRole('button', { name: '再来一局' }));

    expect(app.queryByRole('heading', { level: 3, name: '本局结果' })).not.toBeInTheDocument();
    expect(app.getAllByText('最近结果')).not.toHaveLength(0);
    expect(app.getAllByText('红方获胜（将死获胜）')).not.toHaveLength(0);
    expect(app.getByText('当前回合')).toBeInTheDocument();
    expect(app.getByText('红方')).toBeInTheDocument();
  });

  it('flips an opponent hidden piece through clicks and passes the turn', () => {
    vi.useFakeTimers();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-black-pawn', camp: 'black', type: 'pawn', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);
    const app = within(container);
    const flippingCell = app.getByTestId('cell-0-5');

    fireEvent.click(flippingCell);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(flippingCell).toHaveTextContent('卒');
    expect(flippingCell).toHaveClass('black');
    expect(flippingCell).toHaveAttribute('data-recent-action', 'flip');

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(flippingCell).toHaveAttribute('data-flip-phase', 'none');
    expect(app.getAllByText('红方翻开了黑方卒')).not.toHaveLength(0);
    expect(app.getAllByText('位置：第 1 列，第 6 行')).not.toHaveLength(0);
    expect(app.getAllByText('下一手：黑方')).not.toHaveLength(0);
    expect(app.getByText('黑方')).toBeInTheDocument();
    expect(app.getByText('第 1 手')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
