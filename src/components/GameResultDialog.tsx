import { useEffect, useRef } from 'react';
import type { Camp } from '../game/types.js';
import type { MatchSettlement } from '../network/protocol.js';
import { formatTimeDisplay } from './PlayerClock.js';

export interface GameResultDialogProps {
  settlement: MatchSettlement;
  viewerSide: Camp | null;
  onRematch: () => void;
  onReturnLobby: () => void;
}

export function formatEndgameReason(reason: string): string {
  switch (reason) {
    case 'checkmate':
      return '绝杀：对方已被将死';
    case 'king-captured':
      return '对方将/帅已被吃掉';
    case 'match-timeout':
      return '局时耗尽超时判负';
    case 'step-timeout':
      return '单步用时耗尽超时判负';
    case 'disconnect-timeout':
      return '掉线超过 90 秒超时判负';
    case 'resignation':
      return '对方认输';
    default:
      return '对局结束';
  }
}

export function GameResultDialog({
  settlement,
  viewerSide,
  onRematch,
  onReturnLobby,
}: GameResultDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const rematchBtnRef = useRef<HTMLButtonElement>(null);

  const isWinner = viewerSide !== null && settlement.winner === viewerSide;
  const isDraw = settlement.winner === null;
  const winnerCampLabel = settlement.winner === 'red' ? '红方' : '黑方';

  // 挂载时自动聚焦到主操作按钮，按 Escape 可返回大厅
  useEffect(() => {
    rematchBtnRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onReturnLobby();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onReturnLobby]);

  let outcomeTitle = isDraw
    ? '平局'
    : viewerSide !== null
      ? isWinner
        ? '胜利！'
        : '惜败'
      : `${winnerCampLabel}获胜！`;

  return (
    <div
      aria-labelledby="game-result-title"
      aria-modal="true"
      className="game-result-overlay"
      data-testid="game-result-modal"
      role="dialog"
    >
      <div className={`game-result-dialog ${isWinner ? 'dialog-victory' : 'dialog-defeat'}`} ref={dialogRef}>
        <div className="celebration-container">
          <div
            className={`celebration-piece camp-${settlement.winner} ${isWinner ? 'piece-celebrate' : ''}`}
            data-testid="celebration-piece"
          >
            <span>{settlement.winner === 'red' ? '帅' : '将'}</span>
          </div>
        </div>

        <h2 className="game-result-title" id="game-result-title" data-testid="result-outcome-title">
          {outcomeTitle}
        </h2>

        <div className="game-result-reason" data-testid="result-reason">
          {formatEndgameReason(settlement.reason)}
        </div>

        <div className="game-result-stats" data-testid="result-stats">
          <div className="stat-row">
            <span className="stat-label">红方总用时</span>
            <span className="stat-value">{formatTimeDisplay(settlement.redDurationSeconds * 1000)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">黑方总用时</span>
            <span className="stat-value">{formatTimeDisplay(settlement.blackDurationSeconds * 1000)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">总局时</span>
            <span className="stat-value">
              {formatTimeDisplay((settlement.redDurationSeconds + settlement.blackDurationSeconds) * 1000)}
            </span>
          </div>
        </div>

        <div className="game-result-actions">
          <button
            className="menu-primary btn-rematch"
            data-testid="btn-rematch"
            onClick={onRematch}
            ref={rematchBtnRef}
            type="button"
          >
            再来一局
          </button>
          <button
            className="menu-outline btn-return-lobby"
            data-testid="btn-return-lobby"
            onClick={onReturnLobby}
            type="button"
          >
            返回大厅
          </button>
        </div>
      </div>
    </div>
  );
}
