/**
 * 局域网快捷短语互动领域模型与协议定义：
 * - 纯 TypeScript（不依赖 Node API 与 DOM API），供服务端与客户端共用；
 * - 12 条内置预置短语（白名单，不支持自由文本）；
 * - 5 秒权威频控，3 秒气泡展示；
 * - 消息封包解析与校验。
 */

export type QuickPhraseCategory = 'greeting' | 'praise' | 'think' | 'etiquette';

export interface QuickPhrase {
  id: string;
  category: QuickPhraseCategory;
  text: string;
}

export const QUICK_PHRASE_COOLDOWN_MS = 5000;
export const QUICK_PHRASE_DISPLAY_DURATION_MS = 3000;

export const QUICK_PHRASES: readonly QuickPhrase[] = [
  // 问候类
  { id: 'phrase-greeting-1', category: 'greeting', text: '你好，很高兴和你对弈！' },
  { id: 'phrase-greeting-2', category: 'greeting', text: '请多指教！' },
  // 赞赏类
  { id: 'phrase-praise-1', category: 'praise', text: '好棋！' },
  { id: 'phrase-praise-2', category: 'praise', text: '妙啊，这一步厉害！' },
  { id: 'phrase-praise-3', category: 'praise', text: '佩服佩服！' },
  // 局中催促/思考类
  { id: 'phrase-prompt-1', category: 'think', text: '该你了，快下吧～' },
  { id: 'phrase-think-1', category: 'think', text: '容我深思熟虑一番' },
  { id: 'phrase-think-2', category: 'think', text: '稍等片刻，思考中' },
  // 终局/礼仪类
  { id: 'phrase-etiquette-1', category: 'etiquette', text: '承让承让！' },
  { id: 'phrase-etiquette-2', category: 'etiquette', text: '技不如人，甘拜下风！' },
  { id: 'phrase-rematch-1', category: 'etiquette', text: '再来一局？' },
  { id: 'phrase-farewell-1', category: 'etiquette', text: '青山不改，绿水长流，后会有期！' },
] as const;

export const PRESET_QUICK_PHRASES = QUICK_PHRASES;

export type QuickPhraseId = (typeof QUICK_PHRASES)[number]['id'];

const PHRASE_MAP = new Map<string, QuickPhrase>(
  QUICK_PHRASES.map((phrase) => [phrase.id, phrase]),
);

export function isQuickPhraseId(id: unknown): id is QuickPhraseId {
  return typeof id === 'string' && PHRASE_MAP.has(id);
}

export function getQuickPhraseById(id: string): QuickPhrase | undefined {
  return PHRASE_MAP.get(id);
}

export function getQuickPhraseText(id: string): string | undefined {
  return PHRASE_MAP.get(id)?.text;
}

export interface QuickPhraseEvent {
  eventId: string;
  matchId: string;
  senderMemberId: string;
  phraseId: string;
  text: string;
  sentAt: number;
  nextAllowedAt: number;
}

export type QuickChatRejectCode = 'COOLDOWN' | 'INVALID_PHRASE' | 'MATCH_NOT_ACTIVE' | 'NOT_A_PLAYER';

export interface QuickChatRejection {
  matchId: string;
  requestId: string;
  code: QuickChatRejectCode;
  message: string;
  retryAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePhraseCooldownUntil(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof key === 'string' && typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      result[key] = val;
    } else {
      return null;
    }
  }
  return result;
}

export function parseQuickPhraseEvent(value: unknown): QuickPhraseEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const { eventId, matchId, senderMemberId, phraseId, text, sentAt, nextAllowedAt } = value;
  if (
    typeof eventId !== 'string' ||
    eventId.length === 0 ||
    typeof matchId !== 'string' ||
    matchId.length === 0 ||
    typeof senderMemberId !== 'string' ||
    senderMemberId.length === 0 ||
    !isQuickPhraseId(phraseId) ||
    typeof text !== 'string' ||
    text.length === 0 ||
    typeof sentAt !== 'number' ||
    !Number.isFinite(sentAt) ||
    typeof nextAllowedAt !== 'number' ||
    !Number.isFinite(nextAllowedAt)
  ) {
    return null;
  }
  return {
    eventId,
    matchId,
    senderMemberId,
    phraseId,
    text,
    sentAt,
    nextAllowedAt,
  };
}

export function parseQuickChatRejection(value: unknown): QuickChatRejection | null {
  if (!isRecord(value)) {
    return null;
  }
  const { matchId, requestId, code, message, retryAt } = value;
  const validCodes: QuickChatRejectCode[] = ['COOLDOWN', 'INVALID_PHRASE', 'MATCH_NOT_ACTIVE', 'NOT_A_PLAYER'];
  if (
    typeof matchId !== 'string' ||
    matchId.length === 0 ||
    typeof requestId !== 'string' ||
    typeof code !== 'string' ||
    !validCodes.includes(code as QuickChatRejectCode) ||
    typeof message !== 'string'
  ) {
    return null;
  }
  return {
    matchId,
    requestId,
    code: code as QuickChatRejectCode,
    message,
    ...(typeof retryAt === 'number' && Number.isFinite(retryAt) ? { retryAt } : {}),
  };
}
