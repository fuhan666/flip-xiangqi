import React, { useEffect, useRef, useState } from 'react';
import { PRESET_QUICK_PHRASES, type QuickPhraseId } from '../network/quick-chat';

export interface QuickPhrasePanelProps {
  onSendPhrase: (phraseId: QuickPhraseId) => void;
  disabled?: boolean;
  cooldownUntil?: number;
  serverClockOffsetMs?: number;
}

export const QuickPhrasePanel: React.FC<QuickPhrasePanelProps> = ({
  onSendPhrase,
  disabled = false,
  cooldownUntil = 0,
  serverClockOffsetMs = 0,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 定时刷新当前时间以驱动冷却倒计时
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const effectiveNow = now + serverClockOffsetMs;
  const cooldownRemainingMs = Math.max(0, cooldownUntil - effectiveNow);
  const cooldownRemainingSec = Math.ceil(cooldownRemainingMs / 1000);
  const isInCooldown = cooldownRemainingSec > 0;
  const isTriggerDisabled = disabled || isInCooldown;

  // 点击外部关闭弹层
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectPhrase = (phraseId: QuickPhraseId) => {
    onSendPhrase(phraseId);
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleToggle = () => {
    if (isTriggerDisabled) {
      return;
    }
    setIsOpen((prev) => !prev);
  };

  return (
    <div className="quick-phrase-container">
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="online-action-btn online-btn-phrase"
        data-testid="btn-quick-phrase"
        disabled={isTriggerDisabled}
        onClick={handleToggle}
        ref={triggerRef}
        type="button"
      >
        {isInCooldown ? `短语 (${cooldownRemainingSec}s)` : '短语'}
      </button>

      {isOpen ? (
        <div
          aria-label="快捷短语互动"
          aria-modal="true"
          className="quick-phrase-popover"
          data-testid="quick-phrase-popover"
          ref={panelRef}
          role="dialog"
        >
          <div className="quick-phrase-popover-header">
            <span className="quick-phrase-popover-title">快捷短语</span>
            <button
              aria-label="关闭短语弹层"
              className="quick-phrase-close-btn"
              data-testid="quick-phrase-close"
              onClick={() => setIsOpen(false)}
              type="button"
            >
              ×
            </button>
          </div>
          <div className="quick-phrase-grid">
            {PRESET_QUICK_PHRASES.map((phrase) => (
              <button
                className="quick-phrase-item-btn"
                data-phrase-id={phrase.id}
                data-testid={`quick-phrase-item-${phrase.id}`}
                key={phrase.id}
                onClick={() => handleSelectPhrase(phrase.id)}
                type="button"
              >
                {phrase.text}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
