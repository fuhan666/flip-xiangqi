import type { GameState } from '../game';

interface StatusPanelProps {
  gameState: GameState;
}

export function StatusPanel({ gameState }: StatusPanelProps) {
  return (
    <section className="panel">
      <h2>对局状态</h2>
      <p>当前回合：{gameState.currentTurn === 'red' ? '红方' : '黑方'}</p>
      <p>状态：{gameState.statusMessage}</p>
      <p>将军：{gameState.checkedCamp ? (gameState.checkedCamp === 'red' ? '红方被将军' : '黑方被将军') : '无'}</p>
      {gameState.lastError ? <p className="error">非法操作：{gameState.lastError}</p> : null}
    </section>
  );
}
