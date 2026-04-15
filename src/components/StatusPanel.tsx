import { PIECE_SYMBOLS } from '../game';
import type { Camp, GameHistoryConsequence, GameHistoryEntry, HistoryPieceSnapshot, Position, GameState } from '../game';

interface GameResultSummary {
  archiveLabel: string;
  reasonLabel: string;
  recentActionLabel: string;
  winnerLabel: string;
}

interface StatusPanelProps {
  currentGameSummary: GameResultSummary | null;
  gameState: GameState;
  interactionMessage: string | null;
  recentCompletedGames: GameResultSummary[];
}

interface LiveFeedbackSummary {
  detail: string;
  meta: string;
  tone: 'idle' | 'flip' | 'move' | 'capture' | 'endgame';
  title: string;
}

function campLabel(camp: Camp): string {
  return camp === 'red' ? '红方' : '黑方';
}

function positionLabel(position: Position): string {
  return `第 ${position.x + 1} 列，第 ${position.y + 1} 行`;
}

function pieceLabel(piece: HistoryPieceSnapshot): string {
  return `${campLabel(piece.camp)}${PIECE_SYMBOLS[piece.camp][piece.type]}`;
}

function endgameReasonLabel(reason: Extract<GameHistoryConsequence, { type: 'endgame' }>['reason']): string {
  return reason === 'checkmate' ? '将死获胜' : '吃掉将/帅';
}

function findConsequence<TType extends GameHistoryConsequence['type']>(
  entry: GameHistoryEntry,
  type: TType,
): Extract<GameHistoryConsequence, { type: TType }> | null {
  return (entry.consequences.find((consequence) => consequence.type === type) as Extract<
    GameHistoryConsequence,
    { type: TType }
  > | undefined) ?? null;
}

function buildLiveFeedback(gameState: GameState): LiveFeedbackSummary {
  const recentAction = gameState.recentAction;

  if (!recentAction) {
    return {
      detail: '先翻牌或选择己方明子开始对局。',
      meta: `下一手：${gameState.winner ? '对局结束' : campLabel(gameState.currentTurn)}`,
      title: '暂无最新变化',
      tone: 'idle',
    };
  }

  const capture = findConsequence(recentAction, 'capture');
  const check = findConsequence(recentAction, 'check');
  const endgame = findConsequence(recentAction, 'endgame');

  if (recentAction.action.type === 'flip') {
    return {
      detail: `位置：${positionLabel(recentAction.action.position)}`,
      meta: `下一手：${recentAction.nextTurn ? campLabel(recentAction.nextTurn) : '对局结束'}`,
      title: `${campLabel(recentAction.actor)}翻开了${pieceLabel(recentAction.action.piece)}`,
      tone: 'flip',
    };
  }

  return {
    detail: capture ? `结果：吃掉${pieceLabel(capture.piece)}` : `落点：${positionLabel(recentAction.action.to)}`,
    meta: endgame
      ? `${campLabel(endgame.winner)}获胜（${endgameReasonLabel(endgame.reason)}）`
      : check
        ? `${campLabel(check.camp)}被将军`
        : `下一手：${recentAction.nextTurn ? campLabel(recentAction.nextTurn) : '对局结束'}`,
    title: endgame ? '刚刚完成制胜一手' : capture ? '刚刚吃子' : '刚刚走子',
    tone: endgame ? 'endgame' : capture ? 'capture' : 'move',
  };
}

export function StatusPanel({ currentGameSummary, gameState, interactionMessage, recentCompletedGames }: StatusPanelProps) {
  const currentTurnLabel = gameState.winner ? '对局结束' : campLabel(gameState.currentTurn);
  const checkLabel = gameState.checkedCamp ? `${campLabel(gameState.checkedCamp)}被将军` : '无';
  const winnerLabel = gameState.winner ? `${campLabel(gameState.winner)}胜利` : '进行中';
  const liveFeedback = buildLiveFeedback(gameState);
  const turnTone = gameState.winner ? 'finished' : gameState.currentTurn;

  return (
    <section className="panel">
      <h2>对局状态</h2>
      <div className="status-list">
        <div className={`status-item status-item-turn status-item-turn-${turnTone}`}>
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
      <div className={`status-live-card status-live-card-${liveFeedback.tone}`} data-testid="status-live-feedback">
        <div className="status-live-header">
          <h3>即时反馈</h3>
          <span className="status-live-chip">{gameState.winner ? '终局已确认' : `轮到${campLabel(gameState.currentTurn)}`}</span>
        </div>
        <p className="status-live-title">{liveFeedback.title}</p>
        <p className="status-live-detail">{liveFeedback.detail}</p>
        <p className="status-live-meta">{liveFeedback.meta}</p>
      </div>
      {interactionMessage ? <p className="hint" role="status">操作提示：{interactionMessage}</p> : null}
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
      {gameState.lastError ? <p className="error" role="alert">非法操作：{gameState.lastError}</p> : null}
    </section>
  );
}
