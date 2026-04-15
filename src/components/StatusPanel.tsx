import type { GameState } from '../game';

interface GameResultSummary {
  archiveLabel: string;
  reasonLabel: string;
  recentActionLabel: string;
  winnerLabel: string;
}

interface StatusPanelProps {
  currentGameSummary: GameResultSummary | null;
  gameState: GameState;
  recentCompletedGames: GameResultSummary[];
}

function campLabel(camp: GameState['currentTurn']): string {
  return camp === 'red' ? '红方' : '黑方';
}

export function StatusPanel({ currentGameSummary, gameState, recentCompletedGames }: StatusPanelProps) {
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
      {currentGameSummary ? (
        <div className="status-summary-card">
          <h3>本局结果</h3>
          <div className="status-list">
            <div className="status-item status-item-alert">
              <span className="status-label">胜方</span>
              <strong className="status-value">{currentGameSummary.winnerLabel}</strong>
            </div>
            <div className="status-item">
              <span className="status-label">结束方式</span>
              <strong className="status-value">{currentGameSummary.reasonLabel}</strong>
            </div>
            <div className="status-item">
              <span className="status-label">最近一步</span>
              <strong className="status-value">{currentGameSummary.recentActionLabel}</strong>
            </div>
          </div>
        </div>
      ) : null}
      {recentCompletedGames.length > 0 ? (
        <div className="status-summary-card">
          <h3>最近结果</h3>
          <ul className="recent-results-list">
            {recentCompletedGames.map((summary, index) => (
              <li className="recent-results-item" key={`${summary.archiveLabel}-${index}`}>
                {summary.archiveLabel}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {gameState.lastError ? <p className="error">非法操作：{gameState.lastError}</p> : null}
    </section>
  );
}
