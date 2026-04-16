import { lazy, Suspense } from 'react';
import type { BoardSceneModel } from './boardSceneMapper';

interface BoardSceneProps {
  model: BoardSceneModel;
  onCellClick?: (position: { x: number; y: number }) => void;
}

const RuntimeBoardScene = lazy(async () => {
  const module = await import('./BoardSceneCanvas');
  return {
    default: function RuntimeBoardSceneStage({ model, onCellClick }: BoardSceneProps) {
      return (
        <div aria-label="翻牌中国象棋棋盘 3D 视图" className="board-stage" role="img">
          <module.BoardSceneCanvas model={model} onCellClick={onCellClick} />
        </div>
      );
    },
  };
});

export function isTestEnvironment(): boolean {
  return typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
}

function BoardSceneFallback({ busy }: { busy: boolean }) {
  return (
    <div
      aria-busy={busy}
      aria-label="翻牌中国象棋棋盘 3D 视图"
      className={`board-stage ${busy ? 'board-stage--loading' : 'board-stage--static'}`}
      role="img"
    >
      <div className="board-stage-overlay">
        <strong>3D 棋盘 Beta</strong>
        <span>{busy ? '正在按需加载 Three.js 场景…' : '已启用 3D 棋盘静态回退视图。'}</span>
      </div>
    </div>
  );
}

export function BoardScene({ model, onCellClick }: BoardSceneProps) {
  if (isTestEnvironment()) {
    return <BoardSceneFallback busy={false} />;
  }

  return (
    <Suspense fallback={<BoardSceneFallback busy />}>
      <RuntimeBoardScene model={model} onCellClick={onCellClick} />
    </Suspense>
  );
}
