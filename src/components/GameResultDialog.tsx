import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Camp } from '../game/types.js';
import type { MatchSettlement } from '../network/protocol.js';
import { formatTimeDisplay } from './PlayerClock.js';

export interface GameResultDialogProps {
  recordControls?: ReactNode;
  settlement: MatchSettlement;
  /** 玩家为己方执色；旁观者为 null（只展示胜方与原因，无任何对局发送入口）。 */
  viewerSide: Camp | null;
  /** 玩家模式：再来一局。 */
  onRematch?: () => void;
  /** 玩家模式：返回大厅（含 Escape 快捷路径）。 */
  onReturnLobby?: () => void;
  /** 旁观模式：离开观看。 */
  onLeave?: () => void;
}

export function formatEndgameReason(
  reason: string,
  viewerSide?: Camp | null,
  winner?: Camp | null,
): string {
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
    case 'draw-agreement':
      return '双方握手言和，协商平局';
    case 'resignation':
      if (viewerSide && winner) {
        return viewerSide === winner ? '对方认输' : '己方认输';
      }
      return '一方认输';
    default:
      return '对局结束';
  }
}

export function GameResultDialog({
  settlement,
  recordControls,
  viewerSide,
  onRematch,
  onReturnLobby,
  onLeave,
}: GameResultDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  // 旁观模式的本地关闭：仅隐藏结果层，继续观看，不发送任何对局消息。
  const [dismissed, setDismissed] = useState(false);

  const isSpectator = viewerSide === null;
  const isWinner = viewerSide !== null && settlement.winner === viewerSide;
  const isDraw = settlement.winner === null;
  const winnerCampLabel = settlement.winner === 'red' ? '红方' : '黑方';

  // 挂载时自动聚焦到主操作按钮；玩家按 Escape 返回大厅，旁观者仅本地收起结果层。
  useEffect(() => {
    primaryBtnRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return;
      }
      if (isSpectator) {
        setDismissed(true);
        return;
      }
      onReturnLobby?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSpectator, onReturnLobby]);

  if (dismissed) {
    return null;
  }

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
      <div
        className={`game-result-dialog ${isDraw ? 'dialog-draw' : isWinner ? 'dialog-victory' : 'dialog-defeat'}`}
        ref={dialogRef}
      >
        <div className="celebration-container">
          <div
            className={`celebration-piece camp-${settlement.winner ?? 'draw'} ${isWinner ? 'piece-celebrate' : ''}`}
            data-testid="celebration-piece"
          >
            <span>{isDraw ? '和' : settlement.winner === 'red' ? '帅' : '将'}</span>
          </div>
        </div>

        <h2 className="game-result-title" id="game-result-title" data-testid="result-outcome-title">
          {outcomeTitle}
        </h2>

        <div className="game-result-reason" data-testid="result-reason">
          {formatEndgameReason(settlement.reason, viewerSide, settlement.winner)}
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

        {recordControls}
        <div className="game-result-actions">
          {isSpectator ? (
            <>
              <button
                className="menu-primary btn-continue-watch"
                data-testid="btn-continue-watch"
                onClick={() => setDismissed(true)}
                ref={primaryBtnRef}
                type="button"
              >
                继续观看
              </button>
              <button
                className="menu-outline btn-leave-watch"
                data-testid="btn-leave-watch"
                onClick={() => onLeave?.()}
                type="button"
              >
                离开观看
              </button>
            </>
          ) : (
            <>
              <button
                className="menu-primary btn-rematch"
                data-testid="btn-rematch"
                onClick={onRematch}
                ref={primaryBtnRef}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
