/**
 * 协商模型与校验逻辑：悔棋、求和与事件通知。
 * 纯 TypeScript 实现（不依赖 Node API 与 DOM API），供服务端与客户端共用。
 */

export type NegotiationType = 'undo' | 'draw';

export interface PendingNegotiation {
  negotiationId: string;
  type: NegotiationType;
  initiatorMemberId: string;
  responderMemberId: string;
  baselineRevision: number;
  createdAt: number;
  deadline: number;
}

export type NegotiationEventType =
  | 'undo-request'
  | 'undo-accepted'
  | 'undo-rejected'
  | 'undo-timeout'
  | 'draw-request'
  | 'draw-accepted'
  | 'draw-rejected'
  | 'draw-timeout'
  | 'resigned'
  | 'negotiation-cancelled';

export interface NegotiationEvent {
  id: string;
  type: NegotiationEventType;
  actorMemberId: string;
  createdAt: number;
  message: string;
}

export const NEGOTIATION_TIMEOUT_MS = 30_000;
export const DRAW_COOLDOWN_MS = 10_000;
export const EVENT_TOAST_DURATION_MS = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VALID_NEGOTIATION_TYPES = new Set<string>(['undo', 'draw']);

export function isNegotiationType(value: unknown): value is NegotiationType {
  return typeof value === 'string' && VALID_NEGOTIATION_TYPES.has(value);
}

const VALID_EVENT_TYPES = new Set<string>([
  'undo-request',
  'undo-accepted',
  'undo-rejected',
  'undo-timeout',
  'draw-request',
  'draw-accepted',
  'draw-rejected',
  'draw-timeout',
  'resigned',
  'negotiation-cancelled',
]);

export function isNegotiationEventType(value: unknown): value is NegotiationEventType {
  return typeof value === 'string' && VALID_EVENT_TYPES.has(value);
}

export function parsePendingNegotiation(value: unknown): PendingNegotiation | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    negotiationId,
    type,
    initiatorMemberId,
    responderMemberId,
    baselineRevision,
    createdAt,
    deadline,
  } = value;

  if (typeof negotiationId !== 'string' || negotiationId.length === 0) {
    return null;
  }
  if (!isNegotiationType(type)) {
    return null;
  }
  if (typeof initiatorMemberId !== 'string' || initiatorMemberId.length === 0) {
    return null;
  }
  if (typeof responderMemberId !== 'string' || responderMemberId.length === 0) {
    return null;
  }
  if (typeof baselineRevision !== 'number' || !Number.isSafeInteger(baselineRevision) || baselineRevision < 0) {
    return null;
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    return null;
  }
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= createdAt) {
    return null;
  }

  return {
    negotiationId,
    type,
    initiatorMemberId,
    responderMemberId,
    baselineRevision,
    createdAt,
    deadline,
  };
}

export function parseNegotiationEvent(value: unknown): NegotiationEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, type, actorMemberId, createdAt, message } = value;

  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  if (!isNegotiationEventType(type)) {
    return null;
  }
  if (typeof actorMemberId !== 'string' || actorMemberId.length === 0) {
    return null;
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    return null;
  }
  if (typeof message !== 'string') {
    return null;
  }

  return {
    id,
    type,
    actorMemberId,
    createdAt,
    message,
  };
}

export function parseDrawCooldownUntil(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      return null;
    }
    result[key] = val;
  }
  return result;
}
