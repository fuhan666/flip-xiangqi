import { useEffect, useState } from 'react';
import type { NegotiationEvent } from '../network/negotiation.js';

export interface NegotiationToastProps {
  event: NegotiationEvent | null;
  durationMs?: number;
}

export function NegotiationToast({ event, durationMs = 3000 }: NegotiationToastProps) {
  const [visibleEvent, setVisibleEvent] = useState<NegotiationEvent | null>(null);

  useEffect(() => {
    if (!event) {
      return;
    }
    setVisibleEvent(event);
    const timer = setTimeout(() => {
      setVisibleEvent(null);
    }, durationMs);

    return () => clearTimeout(timer);
  }, [event?.id, durationMs]);

  if (!visibleEvent) {
    return null;
  }

  const outcomeClass =
    visibleEvent.type.endsWith('-accepted')
      ? 'toast-accepted'
      : visibleEvent.type.endsWith('-rejected')
        ? 'toast-rejected'
        : 'toast-timeout';

  return (
    <div
      aria-live="polite"
      className={`negotiation-toast ${outcomeClass}`}
      data-testid="negotiation-toast"
      role="status"
    >
      <span className="negotiation-toast-message">{visibleEvent.message}</span>
    </div>
  );
}
