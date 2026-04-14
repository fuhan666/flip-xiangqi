import type { GameState } from '../game';

interface StatusPanelProps {
  gameState: GameState;
}

function campLabel(camp: GameState['currentTurn']): string {
  return camp === 'red' ? '红方' : '黑方';
}

export function StatusPanel({ gameState }: StatusPanelProps) {
  const currentTurnLabel = gameState.winner ? '对局结束' : campLabel(gameState.currentTurn);
  const checkLabel = gameState.checkedCamp ? `${campLabel(gameState.checkedCamp)}被将军` : '无';
  const winnerLabel = gameState.winner ? `${campLabel(gameState.winner)}胜利` : '进行中';

  return (
    <section className="panel">
      <h2>对局状态</h2>
      <div className="status-list">
        <div className="status-item">
          <span className="status-label">当前回合</span>
          <strong className="status-value">{currentTurnLabel}</strong>
        </div>
        <div className="status-item">
          <span className="status-label">局面</span>
          <strong className="status-value">{gameState.statusMessage}</strong>
        </div>
        <div className={`status-item${gameState.checkedCamp ? ' status-item-alert' : ''}`}>
          <span className="status-label">将军</span>
          <strong className="status-value">{checkLabel}</strong>
        </div>
        <div className={`status-item${gameState.winner ? ' status-item-alert' : ''}`}>
          <span className="status-label">终局</span>
          <strong className="status-value">{winnerLabel}</strong>
        </div>
      </div>
      {gameState.lastError ? <p className="error">非法操作：{gameState.lastError}</p> : null}
    </section>
  );
}
