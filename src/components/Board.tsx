import type { GameState, Position } from '../game';
import { BoardScene } from './three/BoardScene';
import { mapBoardSceneModel } from './three/boardSceneMapper';

interface BoardProps {
  gameState: GameState;
  selectedPosition: Position | null;
  onCellClick: (position: Position) => void;
}

export function Board({ gameState, selectedPosition, onCellClick }: BoardProps) {
  const sceneModel = mapBoardSceneModel(gameState, selectedPosition);

  return (
    <section className="board-shell">
      <div className="board-stage-meta">
        <span className="board-beta-badge">3D Beta</span>
        <p className="board-stage-copy">保留语义点击棋盘，Three.js 场景按需懒加载以降低首屏阻塞。</p>
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
                data-testid={cell.testId}
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
