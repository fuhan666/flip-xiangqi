import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { applyAction, createEmptyGameState } from '../../game';
import type { Piece } from '../../game';
import { Board } from '../Board';

function piece(overrides: Partial<Piece> & Pick<Piece, 'id' | 'camp' | 'type' | 'position'>): Piece {
  return {
    revealed: true,
    captured: false,
    ...overrides,
  };
}

describe('Board', () => {
  it('renders a single 9x10 grid of semantic cell buttons wired to onCellClick', async () => {
    const user = userEvent.setup();
    const onCellClick = vi.fn();
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 3, y: 4 }, revealed: false }),
      ],
    });

    const { container } = render(<Board gameState={gameState} selectedPosition={null} onCellClick={onCellClick} />);

    expect(container.querySelectorAll('[role="grid"]')).toHaveLength(1);
    expect(screen.getByRole('grid', { name: '翻牌中国象棋棋盘' })).toBeInTheDocument();

    const grid = screen.getByRole('grid', { name: '翻牌中国象棋棋盘' });
    expect(within(grid).getAllByRole('button')).toHaveLength(90);
    expect(within(grid).getByTestId('cell-3-4')).toHaveAttribute('aria-label', '第 4 列，第 5 行');
    expect(within(grid).getByTestId('cell-3-4')).toHaveAttribute('type', 'button');

    await user.click(within(grid).getByTestId('cell-3-4'));
    expect(onCellClick).toHaveBeenCalledWith({ x: 3, y: 4 });
  });

  it('derives cell and turn states without leaking hidden piece identities', () => {
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
        piece({ id: 'black-rook', camp: 'black', type: 'rook', position: { x: 1, y: 5 } }),
        piece({ id: 'red-pawn', camp: 'red', type: 'pawn', position: { x: 2, y: 5 } }),
      ],
    });

    render(<Board gameState={gameState} selectedPosition={{ x: 2, y: 5 }} onCellClick={vi.fn()} />);

    const hiddenCell = screen.getByTestId('cell-0-5');
    expect(hiddenCell).toHaveTextContent('暗');
    expect(hiddenCell).toHaveAttribute('data-cell-state', 'hidden');
    expect(hiddenCell).toHaveAttribute('data-turn-state', 'neutral');
    expect(hiddenCell).toHaveAttribute('data-recent-action', 'none');
    expect(hiddenCell).toHaveAttribute('aria-pressed', 'false');
    expect(hiddenCell).toHaveClass('hidden');
    expect(hiddenCell).not.toHaveClass('red');
    expect(hiddenCell).not.toHaveClass('black');
    expect(hiddenCell).toHaveAttribute('aria-label', '第 1 列，第 6 行');

    const opponentCell = screen.getByTestId('cell-1-5');
    expect(opponentCell).toHaveAttribute('data-cell-state', 'revealed');
    expect(opponentCell).toHaveAttribute('data-turn-state', 'opponent');
    expect(opponentCell).toHaveClass('black');
    expect(opponentCell).toHaveTextContent('車');

    const selectedCell = screen.getByTestId('cell-2-5');
    expect(selectedCell).toHaveAttribute('data-cell-state', 'revealed');
    expect(selectedCell).toHaveAttribute('data-turn-state', 'active');
    expect(selectedCell).toHaveAttribute('aria-pressed', 'true');
    expect(selectedCell).toHaveClass('red');
    expect(selectedCell).toHaveClass('selected');
    expect(selectedCell).toHaveTextContent('兵');

    const emptyCell = screen.getByTestId('cell-3-5');
    expect(emptyCell).toHaveAttribute('data-cell-state', 'empty');
    expect(emptyCell).toHaveAttribute('data-turn-state', 'neutral');
    expect(emptyCell.querySelector('.piece-text')).toBeEmptyDOMElement();
  });

  it('shows the current turn and the board legend', () => {
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      ],
    });

    render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);

    expect(screen.getByText('红方回合')).toBeInTheDocument();

    const legend = screen.getByLabelText('棋盘状态说明');
    expect(legend).toHaveTextContent('暗子');
    expect(legend).toHaveTextContent('己方明子');
    expect(legend).toHaveTextContent('对方明子');
    expect(legend).toHaveTextContent('当前选中');
    expect(legend).toHaveTextContent('最近动作');
  });

  it('marks the most recent flip and reveals the piece identity', () => {
    const startingState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    const gameState = applyAction(startingState, { type: 'flip', position: { x: 0, y: 5 } });

    render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);

    const flippedCell = screen.getByTestId('cell-0-5');
    expect(flippedCell).toHaveAttribute('data-recent-action', 'flip');
    expect(flippedCell).toHaveAttribute('data-cell-state', 'revealed');
    expect(flippedCell).toHaveAttribute('data-turn-state', 'opponent');
    expect(flippedCell).toHaveClass('red');
    expect(flippedCell).toHaveTextContent('俥');
    expect(screen.getByText('黑方回合')).toBeInTheDocument();
  });

  it('marks move origin and target for a plain move', () => {
    const startingState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    const gameState = applyAction(startingState, {
      type: 'move',
      from: { x: 0, y: 9 },
      to: { x: 0, y: 8 },
    });

    render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);

    expect(screen.getByTestId('cell-0-9')).toHaveAttribute('data-recent-action', 'move-from');
    expect(screen.getByTestId('cell-0-8')).toHaveAttribute('data-recent-action', 'move-to');
    expect(screen.getByTestId('cell-0-8')).toHaveTextContent('俥');
    expect(screen.getByTestId('cell-4-0')).toHaveAttribute('data-recent-action', 'none');
  });

  it('marks captures and drops captured pieces from the board', () => {
    const startingState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
        piece({ id: 'black-pawn', camp: 'black', type: 'pawn', position: { x: 0, y: 5 } }),
        piece({ id: 'hidden-horse', camp: 'black', type: 'horse', position: { x: 1, y: 5 }, revealed: false }),
      ],
    });

    const gameState = applyAction(startingState, {
      type: 'move',
      from: { x: 0, y: 9 },
      to: { x: 0, y: 5 },
    });

    const { container } = render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);

    expect(screen.getByTestId('cell-0-9')).toHaveAttribute('data-recent-action', 'move-from');
    expect(screen.getByTestId('cell-0-9')).toHaveAttribute('data-cell-state', 'empty');

    const targetCell = screen.getByTestId('cell-0-5');
    expect(targetCell).toHaveAttribute('data-recent-action', 'capture');
    expect(targetCell).toHaveAttribute('data-cell-state', 'revealed');
    expect(targetCell).toHaveAttribute('data-turn-state', 'opponent');
    expect(targetCell).toHaveTextContent('俥');

    expect(screen.getByTestId('cell-1-5')).toHaveAttribute('data-recent-action', 'none');
    expect(screen.getByTestId('cell-1-5')).toHaveAttribute('data-turn-state', 'neutral');
    expect(screen.getByTestId('cell-4-0')).toHaveAttribute('data-turn-state', 'active');
    expect(container.textContent).not.toContain('卒');
  });

  it('renders no canvas or scene layers around the board', () => {
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      ],
    });

    const { container } = render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);

    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('.board-stage')).toBeNull();
    expect(container.querySelectorAll('.board')).toHaveLength(1);
  });

  it('renders identical DOM for hidden pieces regardless of their real identity', () => {
    const renderHiddenCellHtml = (hiddenPiece: Piece): string => {
      const gameState = createEmptyGameState({
        pieces: [
          piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
          piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
          hiddenPiece,
        ],
      });

      const { container, unmount } = render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);
      const html = container.querySelector('[data-testid="cell-0-5"]')?.outerHTML ?? '';
      unmount();
      return html;
    };

    const hiddenRedRookHtml = renderHiddenCellHtml(
      piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
    );
    const hiddenBlackPawnHtml = renderHiddenCellHtml(
      piece({ id: 'hidden-black-pawn', camp: 'black', type: 'pawn', position: { x: 0, y: 5 }, revealed: false }),
    );

    expect(hiddenRedRookHtml).not.toBe('');
    expect(hiddenRedRookHtml).toBe(hiddenBlackPawnHtml);
    expect(hiddenRedRookHtml).toContain('暗');
    expect(hiddenRedRookHtml).not.toContain('俥');
    expect(hiddenRedRookHtml).not.toContain('車');
    expect(hiddenRedRookHtml).not.toContain('卒');
    expect(hiddenRedRookHtml).not.toMatch(/title=|data-piece|data-camp|data-type/);
    expect(hiddenRedRookHtml).not.toContain('piece-face-revealed');
    expect(hiddenRedRookHtml).not.toContain('piece-face-red');
    expect(hiddenRedRookHtml).not.toContain('piece-face-black');
    expect(hiddenRedRookHtml).toContain('piece-face-hidden');
  });

  it('reveals piece identity text and camp class only after the flip', () => {
    const startingState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-black-horse', camp: 'black', type: 'horse', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    const hiddenCellHtml = (() => {
      const { container, unmount } = render(
        <Board gameState={startingState} selectedPosition={null} onCellClick={vi.fn()} />,
      );
      const html = container.querySelector('[data-testid="cell-0-5"]')?.outerHTML ?? '';
      unmount();
      return html;
    })();

    expect(hiddenCellHtml).not.toContain('馬');

    const gameState = applyAction(startingState, { type: 'flip', position: { x: 0, y: 5 } });
    render(<Board gameState={gameState} selectedPosition={null} onCellClick={vi.fn()} />);

    const flippedCell = screen.getByTestId('cell-0-5');
    expect(flippedCell).toHaveClass('black');
    expect(flippedCell).toHaveTextContent('馬');
    expect(flippedCell.querySelector('.piece-text')).toHaveTextContent('馬');
    expect(flippedCell.querySelector('.piece-face-hidden')).toBeNull();
    expect(flippedCell.querySelector('.piece-face-revealed')).not.toBeNull();
  });

  it('renders black perspective with own side (Black) at bottom and dispatches logical coordinates on click', async () => {
    const user = userEvent.setup();
    const onCellClick = vi.fn();
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
      ],
    });

    const { container } = render(
      <Board
        gameState={gameState}
        onCellClick={onCellClick}
        perspective="black"
        selectedPosition={null}
      />,
    );

    const buttons = container.querySelectorAll('.board > button.cell');
    expect(buttons).toHaveLength(90);

    // 屏幕第 1 个格子（视觉顶部左上角 dy=0, dx=0）在黑方视角对应逻辑 (8, 9)
    expect(buttons[0]).toHaveAttribute('data-testid', 'cell-8-9');
    await user.click(buttons[0]);
    expect(onCellClick).toHaveBeenCalledWith({ x: 8, y: 9 });

    // 视觉底排中心（dy=9, dx=4）在黑方视角对应逻辑黑将 (4, 0)
    // 视觉索引 = 9 * 9 + 4 = 85
    expect(buttons[85]).toHaveAttribute('data-testid', 'cell-4-0');
    expect(buttons[85]).toHaveTextContent('将');
    await user.click(buttons[85]);
    expect(onCellClick).toHaveBeenCalledWith({ x: 4, y: 0 });

    // 视觉顶排中心（dy=0, dx=4）对应逻辑红帅 (4, 9)
    // 视觉索引 = 0 * 9 + 4 = 4
    expect(buttons[4]).toHaveAttribute('data-testid', 'cell-4-9');
    expect(buttons[4]).toHaveTextContent('帅');
  });

  it('swaps river text coordinates between red and black perspectives', () => {
    const gameState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      ],
    });

    // 红方视角：楚河在左 (x=225)，汉界在右 (x=675)
    const { container: redContainer, unmount: unmountRed } = render(
      <Board gameState={gameState} onCellClick={vi.fn()} perspective="red" selectedPosition={null} />,
    );
    const redRiverTexts = redContainer.querySelectorAll('.board-artwork-river text');
    expect(redRiverTexts[0]).toHaveTextContent('楚河');
    expect(redRiverTexts[0]).toHaveAttribute('x', '225');
    expect(redRiverTexts[1]).toHaveTextContent('汉界');
    expect(redRiverTexts[1]).toHaveAttribute('x', '675');
    unmountRed();

    // 黑方视角：汉界在左 (x=225)，楚河在右 (x=675)
    const { container: blackContainer } = render(
      <Board gameState={gameState} onCellClick={vi.fn()} perspective="black" selectedPosition={null} />,
    );
    const blackRiverTexts = blackContainer.querySelectorAll('.board-artwork-river text');
    expect(blackRiverTexts[0]).toHaveTextContent('楚河');
    expect(blackRiverTexts[0]).toHaveAttribute('x', '675');
    expect(blackRiverTexts[1]).toHaveTextContent('汉界');
    expect(blackRiverTexts[1]).toHaveAttribute('x', '225');
  });

  it('projects last move rings, trace lines, and capture ghost coordinates in black perspective', () => {
    // 逻辑走子：从 (0, 6) 到 (0, 0)
    // 黑方视角映射后：起点 (8, 3)，终点 (8, 9)
    // SVG cx = 50 + 100 * x, cy = 50 + 100 * y:
    // 起点: cx=850, cy=350
    // 终点: cx=850, cy=950
    const gameStateWithMove = applyAction(
      createEmptyGameState({
        pieces: [
          piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
          piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
          piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
          piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 6 } }),
        ],
      }),
      { type: 'move', from: { x: 0, y: 6 }, to: { x: 0, y: 0 } },
    );

    const { container } = render(
      <Board
        captureGhost={{
          camp: 'black',
          eventKey: 'ghost-1',
          pieceType: 'rook',
          position: { x: 0, y: 0 },
        }}
        gameState={gameStateWithMove}
        onCellClick={vi.fn()}
        perspective="black"
        selectedPosition={null}
        trace={{ eventKey: 'trace-1', from: { x: 0, y: 6 }, to: { x: 0, y: 0 } }}
      />,
    );

    const ringFrom = container.querySelector('.board-last-move-from');
    expect(ringFrom).toHaveAttribute('cx', '850');
    expect(ringFrom).toHaveAttribute('cy', '350');

    const ringTo = container.querySelector('.board-last-move-to');
    expect(ringTo).toHaveAttribute('cx', '850');
    expect(ringTo).toHaveAttribute('cy', '950');

    const traceLine = container.querySelector('.board-trace-line');
    expect(traceLine).toHaveAttribute('x1', '850');
    expect(traceLine).toHaveAttribute('y1', '350');
    expect(traceLine).toHaveAttribute('x2', '850');
    expect(traceLine).toHaveAttribute('y2', '950');

    // captureGhost 在逻辑 (0, 0)，黑方显示坐标 (8, 9)
    // left = ((50 + 100 * 8) / 900) * 100% = 850 / 900 * 100% ≈ 94.444%
    // top = ((50 + 100 * 9) / 1000) * 100% = 95%
    const ghost = screen.getByTestId('capture-ghost');
    expect(ghost.style.left).toBe(`${(850 / 900) * 100}%`);
    expect(ghost.style.top).toBe('95%');
  });

  it('respects hideHeader prop and still renders check banner when in check', () => {
    const checkedState = createEmptyGameState({
      checkedCamp: 'black',
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
      ],
    });

    const { container, rerender } = render(
      <Board gameState={checkedState} hideHeader={true} onCellClick={vi.fn()} selectedPosition={null} />,
    );

    expect(container.querySelector('.board-shell-header')).toBeNull();
    expect(screen.getByText('将军警示：请立即应将')).toBeInTheDocument();

    rerender(<Board gameState={checkedState} hideHeader={false} onCellClick={vi.fn()} selectedPosition={null} />);
    expect(container.querySelector('.board-shell-header')).not.toBeNull();
  });
});

