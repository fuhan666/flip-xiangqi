import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_SYMBOLS, getPieceAt } from '../game';
import type { Camp, GameState, Piece, Position } from '../game';
import { BoardArtwork } from './BoardArtwork';
import { PieceFace } from './PieceFace';

interface BoardProps {
  gameState: GameState;
  selectedPosition: Position | null;
  onCellClick: (position: Position) => void;
}

type CellState = 'empty' | 'hidden' | 'revealed';
type TurnState = 'neutral' | 'active' | 'opponent';
type RecentAction = 'none' | 'flip' | 'move-from' | 'move-to' | 'capture';

interface BoardCellModel {
  cellState: CellState;
  coordinateLabel: string;
  isFaceDown: boolean;
  isSelected: boolean;
  key: string;
  pieceCamp: Camp | null;
  pieceLabel: string;
  position: Position;
  recentAction: RecentAction;
  testId: string;
  turnState: TurnState;
}

interface RecentActionMarkers {
  sourceKey: string | null;
  targetKey: string | null;
  targetMarker: RecentAction;
}

function currentTurnLabel(gameState: GameState): string {
  if (gameState.winner) {
    return '终局已定';
  }

  return gameState.currentTurn === 'red' ? '红方回合' : '黑方回合';
}

function positionKey(position: Position): string {
  return `${position.x}-${position.y}`;
}

function getCellState(piece: Piece | undefined): CellState {
  if (!piece) {
    return 'empty';
  }

  return piece.revealed ? 'revealed' : 'hidden';
}

function getTurnState(piece: Piece | undefined, currentTurn: Camp): TurnState {
  if (!piece || !piece.revealed) {
    return 'neutral';
  }

  return piece.camp === currentTurn ? 'active' : 'opponent';
}

function getRecentActionMarkers(gameState: GameState): RecentActionMarkers {
  const recentAction = gameState.recentAction;

  if (!recentAction) {
    return {
      sourceKey: null,
      targetKey: null,
      targetMarker: 'none',
    };
  }

  if (recentAction.action.type === 'flip') {
    return {
      sourceKey: null,
      targetKey: positionKey(recentAction.action.position),
      targetMarker: 'flip',
    };
  }

  return {
    sourceKey: positionKey(recentAction.action.from),
    targetKey: positionKey(recentAction.action.to),
    targetMarker: recentAction.consequences.some((consequence) => consequence.type === 'capture')
      ? 'capture'
      : 'move-to',
  };
}

function buildBoardCells(gameState: GameState, selectedPosition: Position | null): BoardCellModel[] {
  const markers = getRecentActionMarkers(gameState);
  const cells: BoardCellModel[] = [];

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const position = { x, y };
      const key = positionKey(position);
      const piece = getPieceAt(gameState, position);
      const cellState = getCellState(piece);
      let recentAction: RecentAction = 'none';

      if (key === markers.sourceKey) {
        recentAction = 'move-from';
      } else if (key === markers.targetKey) {
        recentAction = markers.targetMarker;
      }

      cells.push({
        cellState,
        coordinateLabel: `${x},${y}`,
        isFaceDown: cellState === 'hidden',
        isSelected: position.x === selectedPosition?.x && position.y === selectedPosition?.y,
        key,
        pieceCamp: piece?.revealed ? piece.camp : null,
        pieceLabel: piece ? (piece.revealed ? PIECE_SYMBOLS[piece.camp][piece.type] : '暗') : '',
        position,
        recentAction,
        testId: `cell-${x}-${y}`,
        turnState: getTurnState(piece, gameState.currentTurn),
      });
    }
  }

  return cells;
}

export function Board({ gameState, selectedPosition, onCellClick }: BoardProps) {
  const cells = buildBoardCells(gameState, selectedPosition);

  return (
    <section className="board-shell" data-turn={gameState.winner ? 'finished' : gameState.currentTurn}>
      <div className="board-shell-header">
        <div className="board-turn-indicator">
          <span className="board-turn-label">回合焦点</span>
          <strong className="board-turn-value">{currentTurnLabel(gameState)}</strong>
        </div>
        <div className="board-stage-meta">
          <span className="board-beta-badge">操作提示</span>
          <p className="board-stage-copy">点击暗子翻开；选中己方明子后点击目标位置走子。</p>
        </div>
        <ul aria-label="棋盘状态说明" className="board-legend">
          <li className="board-legend-item board-legend-item-hidden">暗子</li>
          <li className="board-legend-item board-legend-item-active">己方明子</li>
          <li className="board-legend-item board-legend-item-opponent">对方明子</li>
          <li className="board-legend-item board-legend-item-selected">当前选中</li>
          <li className="board-legend-item board-legend-item-recent">最近动作</li>
        </ul>
      </div>
      <div className="board-frame">
        <div className="board" role="grid" aria-label="翻牌中国象棋棋盘">
          <BoardArtwork />
          {cells.map((cell) => {
            const classes = ['cell'];
            if (cell.pieceCamp) {
              classes.push(cell.pieceCamp);
            }
            if (cell.isFaceDown) {
              classes.push('hidden');
            }
            if (cell.isSelected) {
              classes.push('selected');
            }

            return (
              <button
                key={cell.key}
                aria-label={`第 ${cell.position.x + 1} 列，第 ${cell.position.y + 1} 行`}
                aria-pressed={cell.isSelected}
                className={classes.join(' ')}
                data-cell-state={cell.cellState}
                data-recent-action={cell.recentAction}
                data-testid={cell.testId}
                data-turn-state={cell.turnState}
                onClick={() => onCellClick(cell.position)}
                type="button"
              >
                <span className="coordinate">{cell.coordinateLabel}</span>
                <PieceFace cellState={cell.cellState} pieceCamp={cell.pieceCamp} pieceLabel={cell.pieceLabel} />
                <span aria-hidden="true" className="state-ring" />
                <span className="piece-text">{cell.pieceLabel}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
