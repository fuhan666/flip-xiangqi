import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function stubReducedMotion() {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('board feedback effects', () => {
  it('draws a transient move trace and keeps last-move rings across flips until undo', () => {
    vi.useFakeTimers();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
        piece({ id: 'hidden-black-pawn', camp: 'black', type: 'pawn', position: { x: 3, y: 3 }, revealed: false }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    fireEvent.click(screen.getByTestId('cell-0-9'));
    fireEvent.click(screen.getByTestId('cell-0-8'));

    const trace = container.querySelector('.board-trace-line');
    expect(trace).not.toBeNull();
    expect(trace).toHaveAttribute('x1', '50');
    expect(trace).toHaveAttribute('y1', '950');
    expect(trace).toHaveAttribute('x2', '50');
    expect(trace).toHaveAttribute('y2', '850');
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('.board-trace-line')).not.toBeNull();
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(container.querySelector('.board-trace-line')).toBeNull();
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('cell-3-3'));
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector('.board-trace-line')).toBeNull();
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '悔棋' }));
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '悔棋' }));
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('shows a one-shot capture ghost that exits and disappears', () => {
    vi.useFakeTimers();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 3, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
        piece({ id: 'black-horse', camp: 'black', type: 'horse', position: { x: 0, y: 5 } }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    fireEvent.click(screen.getByTestId('cell-0-9'));
    fireEvent.click(screen.getByTestId('cell-0-5'));

    const ghost = screen.getByTestId('capture-ghost');
    expect(ghost).toHaveTextContent('馬');
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-recent-action', 'capture');
    expect(screen.getByTestId('cell-0-5')).toHaveTextContent('俥');

    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(container.querySelector('.capture-ghost')).toBeNull();
    vi.useRealTimers();
  });

  it('shows the check banner and a bounded frame ripple on a checking move', () => {
    vi.useFakeTimers();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 3, y: 0 } }),
        piece({ id: 'red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 9 } }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    fireEvent.click(screen.getByTestId('cell-0-9'));
    fireEvent.click(screen.getByTestId('cell-0-0'));

    expect(screen.getByTestId('check-ripple')).toBeInTheDocument();
    expect(screen.getByText('将军警示：请立即应将')).toBeInTheDocument();
    expect(container.querySelector('.board-frame')).toHaveAttribute('data-check', 'black');

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(container.querySelector('.board-check-ripple')).toBeNull();
    expect(screen.getByText('将军警示：请立即应将')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '悔棋' }));
    expect(screen.queryByText('将军警示：请立即应将')).not.toBeInTheDocument();
    expect(container.querySelector('.board-frame')).toHaveAttribute('data-check', 'none');
    vi.useRealTimers();
  });

  it('cancels a running flip cleanly when undoing mid-animation', () => {
    vi.useFakeTimers();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    fireEvent.click(screen.getByTestId('cell-0-5'));
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-flip-phase', 'back');

    fireEvent.click(screen.getByRole('button', { name: '悔棋' }));

    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-cell-state', 'hidden');
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-flip-phase', 'none');
    expect(container.textContent).not.toContain('俥');

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId('cell-0-5')).toHaveAttribute('data-cell-state', 'hidden');
    expect(container.textContent).not.toContain('俥');
    vi.useRealTimers();
  });

  it('reveals immediately and skips transient effects under prefers-reduced-motion', () => {
    stubReducedMotion();
    const initialState = createEmptyGameState({
      pieces: [
        piece({ id: 'red-king', camp: 'red', type: 'king', position: { x: 4, y: 9 } }),
        piece({ id: 'black-king', camp: 'black', type: 'king', position: { x: 4, y: 0 } }),
        piece({ id: 'center-blocker', camp: 'red', type: 'pawn', position: { x: 4, y: 5 } }),
        piece({ id: 'hidden-red-rook', camp: 'red', type: 'rook', position: { x: 0, y: 5 }, revealed: false }),
      ],
    });

    const { container } = render(<App initialState={initialState} />);

    fireEvent.click(screen.getByTestId('cell-0-5'));

    const flippedCell = screen.getByTestId('cell-0-5');
    expect(flippedCell).toHaveAttribute('data-cell-state', 'revealed');
    expect(flippedCell).toHaveAttribute('data-flip-phase', 'none');
    expect(flippedCell).toHaveTextContent('俥');
    expect(within(screen.getByTestId('status-live-feedback')).getByText('红方翻开了红方俥')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cell-4-0'));
    fireEvent.click(screen.getByTestId('cell-3-0'));

    expect(container.querySelector('.board-trace-line')).toBeNull();
    expect(container.querySelector('.capture-ghost')).toBeNull();
    expect(container.querySelectorAll('.board-last-move-ring')).toHaveLength(2);
    expect(within(screen.getByTestId('status-live-feedback')).getByText('刚刚走子')).toBeInTheDocument();
  });
});
