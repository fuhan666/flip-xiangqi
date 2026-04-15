import { lazy, Suspense } from 'react';
import type { BoardSceneModel } from './boardSceneMapper';

interface BoardSceneProps {
  model: BoardSceneModel;
}

const RuntimeBoardScene = lazy(async () => {
  const module = await import('./BoardSceneCanvas');
  return { default: module.BoardSceneCanvas };
});

function isTestEnvironment(): boolean {
  return typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
}

export function BoardScene({ model }: BoardSceneProps) {
  if (isTestEnvironment()) {
    return <div aria-label="翻牌中国象棋棋盘 3D 视图" className="board-stage board-stage--static" role="img" />;
  }

  return (
    <div aria-label="翻牌中国象棋棋盘 3D 视图" className="board-stage" role="img">
      <Suspense fallback={null}>
        <RuntimeBoardScene model={model} />
      </Suspense>
    </div>
  );
}
