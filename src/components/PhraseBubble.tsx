import React, { useEffect, useState } from 'react';
import type { QuickPhraseEvent } from '../network/protocol';
import { QUICK_PHRASE_DISPLAY_DURATION_MS } from '../network/quick-chat';

export interface PhraseBubbleProps {
  event: QuickPhraseEvent | null | undefined;
  side: 'opponent' | 'self';
  testId?: string;
}

export const PhraseBubble: React.FC<PhraseBubbleProps> = ({ event, side, testId }) => {
  const [activeEvent, setActiveEvent] = useState<QuickPhraseEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!event) {
      return;
    }

    const elapsed = Date.now() - event.sentAt;
    const remaining = QUICK_PHRASE_DISPLAY_DURATION_MS - Math.max(0, elapsed);
    if (remaining <= 0) {
      return;
    }

    setActiveEvent(event);
    setVisible(true);

    const timer = setTimeout(() => {
      setVisible(false);
      setActiveEvent(null);
    }, remaining);

    return () => clearTimeout(timer);
  }, [event]);

  if (!visible || !activeEvent) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className={`quick-phrase-bubble phrase-bubble-${side}`}
      data-phrase-id={activeEvent.phraseId}
      data-testid={testId ?? `phrase-bubble-${side}`}
      role="status"
    >
      <span className="phrase-bubble-tail" />
      <span className="phrase-bubble-text">{activeEvent.text}</span>
    </div>
  );
};
