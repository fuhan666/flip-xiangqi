import { describe, expect, it } from 'vitest';
import {
  PRESET_QUICK_PHRASES,
  QUICK_PHRASES,
  QUICK_PHRASE_COOLDOWN_MS,
  QUICK_PHRASE_DISPLAY_DURATION_MS,
  getQuickPhraseById,
  getQuickPhraseText,
  isQuickPhraseId,
  parseQuickChatRejection,
  parseQuickPhraseEvent,
} from '../quick-chat';

describe('quick-chat domain and protocol validation', () => {
  it('defines exactly 12 preset Chinese phrases with non-empty text and category', () => {
    expect(QUICK_PHRASES).toHaveLength(12);
    expect(PRESET_QUICK_PHRASES).toBe(QUICK_PHRASES);

    const ids = new Set<string>();
    for (const phrase of QUICK_PHRASES) {
      expect(phrase.id).toMatch(/^phrase-[a-z]+-[0-9]+$/);
      expect(phrase.text.trim().length).toBeGreaterThan(0);
      expect(['greeting', 'praise', 'think', 'etiquette']).toContain(phrase.category);
      expect(ids.has(phrase.id)).toBe(false);
      ids.add(phrase.id);
    }
  });

  it('strictly validates whitelist IDs and rejects arbitrary text/empty values', () => {
    expect(isQuickPhraseId('phrase-greeting-1')).toBe(true);
    expect(isQuickPhraseId('phrase-praise-1')).toBe(true);
    expect(isQuickPhraseId('phrase-rematch-1')).toBe(true);

    expect(isQuickPhraseId('free-form-text')).toBe(false);
    expect(isQuickPhraseId('你好呀')).toBe(false);
    expect(isQuickPhraseId('')).toBe(false);
    expect(isQuickPhraseId(null)).toBe(false);
    expect(isQuickPhraseId(undefined)).toBe(false);
    expect(isQuickPhraseId(123)).toBe(false);
  });

  it('correctly retrieves phrase details and text by ID', () => {
    const greeting = getQuickPhraseById('phrase-greeting-1');
    expect(greeting).toBeDefined();
    expect(greeting?.text).toBe('你好，很高兴和你对弈！');
    expect(getQuickPhraseText('phrase-greeting-1')).toBe('你好，很高兴和你对弈！');

    expect(getQuickPhraseById('non-existent')).toBeUndefined();
    expect(getQuickPhraseText('non-existent')).toBeUndefined();
  });

  it('specifies authoritative cooldown and display duration constants', () => {
    expect(QUICK_PHRASE_COOLDOWN_MS).toBe(5000);
    expect(QUICK_PHRASE_DISPLAY_DURATION_MS).toBe(3000);
  });

  it('parses valid QuickPhraseEvent objects and rejects malformed payloads', () => {
    const validRaw = {
      eventId: 'evt-1',
      matchId: 'match-1',
      senderMemberId: 'mem-1',
      phraseId: 'phrase-greeting-1',
      text: '你好，很高兴和你对弈！',
      sentAt: 1000,
      nextAllowedAt: 6000,
    };
    const parsed = parseQuickPhraseEvent(validRaw);
    expect(parsed).toEqual(validRaw);

    expect(parseQuickPhraseEvent(null)).toBeNull();
    expect(parseQuickPhraseEvent({ ...validRaw, eventId: '' })).toBeNull();
    expect(parseQuickPhraseEvent({ ...validRaw, phraseId: 'invalid-phrase' })).toBeNull();
    expect(parseQuickPhraseEvent({ ...validRaw, sentAt: 'not-a-number' })).toBeNull();
  });

  it('parses valid QuickChatRejection objects and rejects malformed payloads', () => {
    const validRaw = {
      matchId: 'match-1',
      requestId: 'req-1',
      code: 'COOLDOWN',
      message: '冷却中',
      retryAt: 7000,
    };
    const parsed = parseQuickChatRejection(validRaw);
    expect(parsed).toEqual(validRaw);

    expect(parseQuickChatRejection(null)).toBeNull();
    expect(parseQuickChatRejection({ ...validRaw, code: 'UNKNOWN_CODE' })).toBeNull();
    expect(parseQuickChatRejection({ ...validRaw, matchId: '' })).toBeNull();
  });
});
