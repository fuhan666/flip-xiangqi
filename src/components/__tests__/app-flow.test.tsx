import { render, screen } from '@testing-library/react';
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

    await user.click(screen.getByTestId('cell-0-9'));
    await user.click(screen.getByTestId('cell-0-5'));

    expect(screen.getByTestId('cell-0-5')).toHaveTextContent('俥');
    expect(screen.getByText(/当前回合：黑方/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重新开局' }));

    expect(screen.getByText(/当前回合：红方/)).toBeInTheDocument();
  });
});
