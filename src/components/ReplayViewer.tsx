import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Camp } from '../game';
import { moveText, reasonLabels, replayFrame } from '../records/record';
import type { GameRecord } from '../records/record';
import { Board } from './Board';

export function ReplayViewer({ record, perspective = 'red', onClose }: { record: GameRecord; perspective?: Camp; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const movesList = useRef<HTMLOListElement>(null);
  const [frozen] = useState(() => JSON.parse(JSON.stringify(record)) as GameRecord);
  const state = replayFrame(frozen, step);
  const action = state.recentAction?.action;
  const trace = action?.type === 'move' ? { eventKey: `replay-${step}`, from: action.from, to: action.to } : null;
  useEffect(() => {
    const list = movesList.current;
    const active = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !active) return;
    if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = active.offsetTop + active.offsetHeight - list.clientHeight;
    }
  }, [step]);
  useEffect(() => {
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopImmediatePropagation(); onClose(); }
      else if (event.key === 'Tab') {
        const buttons = root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first.focus(); }
      }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); setStep((s) => Math.max(0, s - 1)); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); setStep((s) => Math.min(frozen.moves.length, s + 1)); }
      else if (event.key === 'Home') { event.preventDefault(); setStep(0); }
      else if (event.key === 'End') { event.preventDefault(); setStep(frozen.moves.length); }
    };
    window.addEventListener('keydown', key, true);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', key, true); if (previous instanceof HTMLElement) previous.focus(); };
  }, [frozen, onClose]);
  return createPortal(<div className="replay-overlay" role="dialog" aria-modal="true" aria-label="棋谱复盘" data-testid="replay-viewer" tabIndex={-1} ref={root}>
    <div className="replay-header">
      <div className="replay-heading"><h2>棋谱复盘</h2><button type="button" onClick={onClose}>关闭复盘</button></div>
      <div className="replay-toolbar">
        <p role="status">第 {step} / {frozen.moves.length} 步{step === 0 ? ' · 初始局面' : ''}</p>
        <div className="record-actions">
          <button type="button" disabled={step === 0} onClick={() => setStep(0)}>首步</button>
          <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>上一步</button>
          <button type="button" disabled={step === frozen.moves.length} onClick={() => setStep(step + 1)}>下一步</button>
          <button type="button" disabled={step === frozen.moves.length} onClick={() => setStep(frozen.moves.length)}>末步</button>
        </div>
      </div>
    </div>
    <div className="replay-layout">
      <Board gameState={state} selectedPosition={null} onCellClick={() => {}} disabled hideHeader currentActionOnly perspective={perspective} trace={trace} />
      <section className="panel replay-sidebar">
        {step === frozen.moves.length ? <p data-testid="replay-result">{frozen.result.winner ? `${frozen.result.winner === 'red' ? '红方' : '黑方'}获胜` : '平局'} · {reasonLabels[frozen.result.reason]}</p> : null}
        <p>只读复盘 · 方向键逐步查看，Home/End 跳转，Esc 关闭。</p>
        <ol className="replay-moves" aria-label="完整步序" ref={movesList}>
          {frozen.moves.map((move) => <li key={move.stepNumber}><button type="button" aria-current={step === move.stepNumber ? 'step' : undefined} onClick={() => setStep(move.stepNumber)}>{moveText(move)}</button></li>)}
        </ol>
      </section>
    </div>
  </div>, document.body);
}
