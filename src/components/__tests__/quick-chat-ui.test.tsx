import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhraseBubble } from '../PhraseBubble';
import { QuickPhrasePanel } from '../QuickPhrasePanel';
import type { QuickPhraseEvent } from '../../network/protocol';
import { QUICK_PHRASES } from '../../network/quick-chat';

describe('PhraseBubble UI component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders phrase text and disappears automatically after 3 seconds', () => {
    const event: QuickPhraseEvent = {
      eventId: 'evt-1',
      matchId: 'match-1',
      senderMemberId: 'mem-1',
      phraseId: 'phrase-greeting-1',
      text: '你好，很高兴和你对弈！',
      sentAt: Date.now(),
      nextAllowedAt: Date.now() + 5000,
    };

    render(<PhraseBubble event={event} side="opponent" />);

    const bubble = screen.getByTestId('phrase-bubble-opponent');
    expect(bubble).toBeInTheDocument();
    expect(bubble).toHaveTextContent('你好，很高兴和你对弈！');
    expect(bubble).toHaveAttribute('role', 'status');
    expect(bubble).toHaveAttribute('aria-live', 'polite');
    expect(bubble.className).toContain('phrase-bubble-opponent');

    // 前进 3000ms 后气泡自动关闭
    act(() => {
      vi.advanceTimersByTime(3100);
    });

    expect(screen.queryByTestId('phrase-bubble-opponent')).not.toBeInTheDocument();
  });

  it('does not render expired events older than 3 seconds', () => {
    const expiredEvent: QuickPhraseEvent = {
      eventId: 'evt-2',
      matchId: 'match-1',
      senderMemberId: 'mem-2',
      phraseId: 'phrase-praise-1',
      text: '好棋！',
      sentAt: Date.now() - 3500,
      nextAllowedAt: Date.now() + 1500,
    };

    render(<PhraseBubble event={expiredEvent} side="self" />);
    expect(screen.queryByTestId('phrase-bubble-self')).not.toBeInTheDocument();
  });
});

describe('QuickPhrasePanel UI component', () => {
  it('opens popover dialog with 12 preset phrases on trigger click', () => {
    const onSend = vi.fn();
    render(<QuickPhrasePanel onSendPhrase={onSend} />);

    const triggerBtn = screen.getByTestId('btn-quick-phrase');
    expect(triggerBtn).toHaveTextContent('短语');
    expect(triggerBtn).not.toBeDisabled();
    expect(screen.queryByTestId('quick-phrase-popover')).not.toBeInTheDocument();

    // 点击打开
    fireEvent.click(triggerBtn);
    expect(screen.getByTestId('quick-phrase-popover')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '快捷短语互动' })).toBeInTheDocument();

    // 检查包含全部 12 条预置短语
    for (const phrase of QUICK_PHRASES) {
      expect(screen.getByTestId(`quick-phrase-item-${phrase.id}`)).toHaveTextContent(phrase.text);
    }

    // 点击某一条短语
    fireEvent.click(screen.getByTestId('quick-phrase-item-phrase-greeting-1'));
    expect(onSend).toHaveBeenCalledWith('phrase-greeting-1');
    expect(screen.queryByTestId('quick-phrase-popover')).not.toBeInTheDocument();
  });

  it('closes popover on close button click and on Escape key', () => {
    const onSend = vi.fn();
    render(<QuickPhrasePanel onSendPhrase={onSend} />);

    fireEvent.click(screen.getByTestId('btn-quick-phrase'));
    expect(screen.getByTestId('quick-phrase-popover')).toBeInTheDocument();

    // 点击关闭按钮
    fireEvent.click(screen.getByTestId('quick-phrase-close'));
    expect(screen.queryByTestId('quick-phrase-popover')).not.toBeInTheDocument();

    // 再次打开并通过 Esc 键关闭
    fireEvent.click(screen.getByTestId('btn-quick-phrase'));
    expect(screen.getByTestId('quick-phrase-popover')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('quick-phrase-popover')).not.toBeInTheDocument();
  });

  it('displays cooldown countdown and disables trigger when in cooldown', () => {
    const onSend = vi.fn();
    const cooldownUntil = Date.now() + 4500;
    render(<QuickPhrasePanel cooldownUntil={cooldownUntil} onSendPhrase={onSend} />);

    const triggerBtn = screen.getByTestId('btn-quick-phrase');
    expect(triggerBtn).toBeDisabled();
    expect(triggerBtn.textContent).toMatch(/短语 \([1-5]s\)/);

    // 禁用态下点击不能打开弹窗
    fireEvent.click(triggerBtn);
    expect(screen.queryByTestId('quick-phrase-popover')).not.toBeInTheDocument();
  });
});
