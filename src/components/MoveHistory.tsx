import { PIECE_SYMBOLS } from '../game';
import type { Camp, GameHistoryConsequence, GameHistoryEntry, HistoryPieceSnapshot, Position } from '../game';

interface MoveHistoryProps {
  recentAction: GameHistoryEntry | null;
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

function actionSummary(entry: GameHistoryEntry): string {
  if (entry.action.type === 'flip') {
    return `${campLabel(entry.actor)}翻开了${pieceLabel(entry.action.piece)}`;
  }

  return `${campLabel(entry.actor)}移动${pieceLabel(entry.action.piece)}`;
}

function actionDetail(entry: GameHistoryEntry): string {
  if (entry.action.type === 'flip') {
    return `位置：${positionLabel(entry.action.position)}`;
  }

  return `路线：${positionLabel(entry.action.from)} -> ${positionLabel(entry.action.to)}`;
}

function consequenceLabel(consequence: GameHistoryConsequence): string {
  if (consequence.type === 'capture') {
    return `结果：吃掉${pieceLabel(consequence.piece)}`;
  }

  if (consequence.type === 'check') {
    return `结果：${campLabel(consequence.camp)}被将军`;
  }

  return consequence.reason === 'checkmate'
    ? `结果：${campLabel(consequence.winner)}胜利（将死）`
    : `结果：${campLabel(consequence.winner)}胜利（将/帅被吃）`;
}

export function MoveHistory({ recentAction }: MoveHistoryProps) {
  return (
    <section className="panel move-history-panel">
      <h2>最近一步</h2>
      {recentAction ? (
        <div className="move-history-content">
          <p className="move-history-turn">第 {recentAction.turnNumber} 手</p>
          <p className="move-history-summary">{actionSummary(recentAction)}</p>
          <p className="move-history-detail">{actionDetail(recentAction)}</p>
          {recentAction.consequences.map((consequence, index) => (
            <p className="move-history-consequence" key={`${consequence.type}-${index}`}>
              {consequenceLabel(consequence)}
            </p>
          ))}
          <p className="move-history-next-turn">下一手：{recentAction.nextTurn ? campLabel(recentAction.nextTurn) : '对局结束'}</p>
        </div>
      ) : (
        <p className="move-history-empty">暂无最近一步，先翻牌或移动明子。</p>
      )}
    </section>
  );
}
