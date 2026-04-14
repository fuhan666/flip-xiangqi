import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_SYMBOLS } from '../game';
import type { GameState, Position } from '../game';

interface BoardProps {
  gameState: GameState;
  selectedPosition: Position | null;
  onCellClick: (position: Position) => void;
}

export function Board({ gameState, selectedPosition, onCellClick }: BoardProps) {
  return (
    <div className="board" role="grid" aria-label="翻牌中国象棋棋盘">
      {Array.from({ length: BOARD_HEIGHT }, (_, y) =>
        Array.from({ length: BOARD_WIDTH }, (_, x) => {
          const piece = gameState.pieces.find(
            (item) => !item.captured && item.position?.x === x && item.position?.y === y,
          );
          const isSelected = selectedPosition?.x === x && selectedPosition?.y === y;
          const classes = ['cell'];
          if (piece) {
            classes.push(piece.camp);
          }
          if (!piece?.revealed) {
            classes.push('hidden');
          }
          if (isSelected) {
            classes.push('selected');
          }

          return (
            <button
              key={`${x}-${y}`}
              className={classes.join(' ')}
              data-testid={`cell-${x}-${y}`}
              onClick={() => onCellClick({ x, y })}
              type="button"
            >
              <span className="coordinate">{x},{y}</span>
              <span className="piece-text">
                {piece ? (piece.revealed ? PIECE_SYMBOLS[piece.camp][piece.type] : '暗') : ''}
              </span>
            </button>
          );
        }),
      )}
    </div>
  );
}
