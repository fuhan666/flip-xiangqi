import type { GameState, Position } from '../game';
import { BoardScene } from './three/BoardScene';
import { mapBoardSceneModel } from './three/boardSceneMapper';

interface BoardProps {
  gameState: GameState;
  selectedPosition: Position | null;
  onCellClick: (position: Position) => void;
}

function currentTurnLabel(gameState: GameState): string {
  if (gameState.winner) {
    return '终局已定';
  }

  return gameState.currentTurn === 'red' ? '红方回合' : '黑方回合';
}

export function Board({ gameState, selectedPosition, onCellClick }: BoardProps) {
  const sceneModel = mapBoardSceneModel(gameState, selectedPosition);

  return (
    <section className="board-shell" data-turn={gameState.winner ? 'finished' : gameState.currentTurn}>
      <div className="board-shell-header">
        <div className="board-turn-indicator">
          <span className="board-turn-label">回合焦点</span>
          <strong className="board-turn-value">{currentTurnLabel(gameState)}</strong>
        </div>
        <div className="board-stage-meta">
          <span className="board-beta-badge">3D Beta</span>
          <p className="board-stage-copy">保留语义点击棋盘，Three.js 场景按需懒加载以降低首屏阻塞。</p>
        </div>
        <ul aria-label="棋盘状态说明" className="board-legend">
          <li className="board-legend-item board-legend-item-hidden">暗子</li>
          <li className="board-legend-item board-legend-item-active">己方明子</li>
          <li className="board-legend-item board-legend-item-opponent">对方明子</li>
          <li className="board-legend-item board-legend-item-selected">当前选中</li>
          <li className="board-legend-item board-legend-item-recent">最近动作</li>
        </ul>
      </div>
      <div className="board-stage-frame">
        <BoardScene model={sceneModel} />
        <div className="board" role="grid" aria-label="翻牌中国象棋棋盘">
          {sceneModel.cells.map((cell) => {
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
                <span className="piece-text">{cell.pieceLabel}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
