import { useEffect, useState } from 'react';
import type { PendingNegotiation } from '../network/negotiation.js';

export interface NegotiationDialogProps {
  pendingNegotiation: PendingNegotiation;
  isTarget: boolean;
  onReply: (agree: boolean) => void;
}

export function NegotiationDialog({
  pendingNegotiation,
  isTarget,
  onReply,
}: NegotiationDialogProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const totalDuration = 30_000;
  const remainingMs = Math.max(0, pendingNegotiation.deadline - now);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const progressPercent = Math.min(100, Math.max(0, (remainingMs / totalDuration) * 100));

  const isUndo = pendingNegotiation.type === 'undo';
  const title = isTarget
    ? isUndo
      ? '对方申请悔棋'
      : '对方请求和棋'
    : isUndo
      ? '悔棋申请已发出'
      : '求和申请已发出';

  const promptText = isTarget
    ? isUndo
      ? '对方申请悔棋（回退 1 步），是否同意？'
      : '对方请求和棋，是否同意？'
    : '正在等待对方做出决定，棋盘与走子暂时锁定...';

  return (
    <div
      aria-labelledby="negotiation-title"
      aria-modal="true"
      className="negotiation-overlay"
      data-testid="negotiation-dialog"
      role="dialog"
    >
      <div className="negotiation-dialog-panel">
        <div className="negotiation-dialog-header">
          <span className="negotiation-badge">{isUndo ? '悔棋协商' : '求和协商'}</span>
          <h3 className="negotiation-title" id="negotiation-title">
            {title}
          </h3>
        </div>

        <div className="negotiation-countdown-container">
          <div className="negotiation-countdown-bar" style={{ width: `${progressPercent}%` }} />
          <span className="negotiation-countdown-text">
            {remainingSec > 0 ? `倒计时 ${remainingSec} 秒` : '即将超时'}
          </span>
        </div>

        <p className="negotiation-prompt">{promptText}</p>

        {isTarget ? (
          <div className="negotiation-actions">
            <button
              className="negotiation-btn negotiation-btn-agree"
              data-testid="negotiation-agree-btn"
              onClick={() => onReply(true)}
              type="button"
            >
              同意
            </button>
            <button
              className="negotiation-btn negotiation-btn-reject"
              data-testid="negotiation-reject-btn"
              onClick={() => onReply(false)}
              type="button"
            >
              拒绝
            </button>
          </div>
        ) : (
          <div className="negotiation-waiting-state">
            <span className="negotiation-spinner" aria-hidden="true" />
            <span>请稍候，等待对方回应...</span>
          </div>
        )}
      </div>
    </div>
  );
}
