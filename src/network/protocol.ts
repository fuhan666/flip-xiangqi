/**
 * 连接层协议：客户端与宿主共用的封包格式、握手消息、错误码与校验逻辑。
 *
 * 该文件必须保持纯 TypeScript（不依赖 Node API 与 DOM API），
 * 以便同时被浏览器客户端与 Node 宿主服务引用。
 */
import {
  isSidePreference,
  isTimeControlId,
  parseLobbyState,
  parseStartParameters,
  type LobbyRejectCode,
  type LobbyState,
  type SidePreference,
  type StartParameters,
  type TimeControlId,
} from './lobby.js';
import {
  parseGameStateSnapshot,
  parseMatchAction,
  parseMatchClockSnapshot,
  parseMatchSettlement,
  parseMatchSnapshot,
  type MatchAction,
  type MatchClockSnapshot,
  type MatchSettlement,
  type MatchSnapshot,
} from './match.js';
import type { GameStateSnapshot } from '../game/index.js';

// 线格式使用的领域类型从协议入口统一再导出，调用方无需两个导入源。
export type { LobbyRejectCode, LobbyState, SidePreference, StartParameters, TimeControlId } from './lobby.js';
export type { EndgameReason, MatchAction, MatchClockSnapshot, MatchEvent, MatchSettlement, MatchSnapshot } from './match.js';
export type { NegotiationEvent, NegotiationEventType, NegotiationType, PendingNegotiation } from './negotiation.js';
export type {
  QuickPhrase,
  QuickPhraseCategory,
  QuickPhraseEvent,
  QuickPhraseId,
  QuickChatRejectCode,
  QuickChatRejection,
} from './quick-chat.js';
export {
  QUICK_PHRASES,
  QUICK_PHRASE_COOLDOWN_MS,
  QUICK_PHRASE_DISPLAY_DURATION_MS,
  getQuickPhraseById,
  getQuickPhraseText,
  isQuickPhraseId,
  parsePhraseCooldownUntil,
  parseQuickChatRejection,
  parseQuickPhraseEvent,
} from './quick-chat.js';

import {
  parseDrawCooldownUntil,
  parseNegotiationEvent,
  parsePendingNegotiation,
  type NegotiationEvent,
  type PendingNegotiation,
} from './negotiation.js';
import {
  parsePhraseCooldownUntil,
  parseQuickChatRejection,
  parseQuickPhraseEvent,
  type QuickChatRejection,
  type QuickPhraseEvent,
} from './quick-chat.js';
import { parseMatchEvents, type MatchEvent } from './match.js';

/** v6：增加只读旁观身份（spectator）与旁观者同步/恢复。 */
export const PROTOCOL_VERSION = 6;

/** WebSocket 握手路径（房间服务同时在该路径上提供客人页面）。 */
export const WS_PATH = '/ws';

/** 执色玩家身份：只有 host/guest 占席位、参与准备就绪与对局动作。 */
export type PlayerRole = 'host' | 'guest';

/** 房间成员身份：两位执色玩家 + 可选的只读旁观者。 */
export type Role = PlayerRole | 'spectator';

export function isPlayerRole(value: unknown): value is PlayerRole {
  return value === 'host' || value === 'guest';
}

export function isRole(value: unknown): value is Role {
  return value === 'host' || value === 'guest' || value === 'spectator';
}

/** 成员离开原因：主动离开或意外掉线，用于卡片上的原因标注。 */
export type MemberLeaveReason = 'left' | 'dropped';

export interface MemberSnapshot {
  id: string;
  role: Role;
  name: string;
  connected: boolean;
  leaveReason?: MemberLeaveReason;
}

export type RoomClosedReason = 'host-closed' | 'host-disconnected' | 'server-stopped';

/** 服务端可稳定预期的错误码。 */
export type ServerErrorCode =
  | 'INVALID_MESSAGE'
  | 'VERSION_MISMATCH'
  | 'UNAUTHORIZED'
  | 'ROOM_FULL'
  | 'ROOM_CLOSED'
  | 'HANDSHAKE_TIMEOUT'
  | 'INTERNAL_ERROR';

/** 客户端本地错误（地址解析、连接超时、宿主不可用等），不来自服务端。 */
export type LocalErrorCode =
  | 'INVALID_ADDRESS'
  | 'CONNECT_TIMEOUT'
  | 'CONNECT_FAILED'
  | 'HOST_UNAVAILABLE'
  | 'ALREADY_CONNECTED';

export type ErrorCode = ServerErrorCode | LocalErrorCode;

/**
 * WebSocket close code 映射：服务端以 4000+ 的业务码关闭连接，
 * 客户端据此还原具体原因；未知码按通用失败处理。
 */
export const CLOSE_CODES = {
  INVALID_MESSAGE: 4000,
  VERSION_MISMATCH: 4001,
  UNAUTHORIZED: 4002,
  ROOM_FULL: 4003,
  ROOM_CLOSED: 4004,
  HANDSHAKE_TIMEOUT: 4005,
  INTERNAL_ERROR: 4009,
} as const satisfies Record<ServerErrorCode, number>;

export function closeCodeForError(code: ServerErrorCode): number {
  return CLOSE_CODES[code];
}

export function serverErrorCodeForCloseCode(code: number): ServerErrorCode | null {
  const entries = Object.entries(CLOSE_CODES) as Array<[ServerErrorCode, number]>;
  for (const [errorCode, closeCode] of entries) {
    if (closeCode === code) {
      return errorCode;
    }
  }
  return null;
}

interface Envelope {
  version: number;
  type: string;
  requestId?: string;
  roomId: string | null;
  payload?: unknown;
}

export interface HelloPayload {
  role: Role;
  name: string;
  token?: string;
  resumeToken?: string;
}

export type ClientMessage =
  | (Envelope & { type: 'hello'; roomId: null | string; payload: HelloPayload })
  | (Envelope & { type: 'leave'; roomId: string; payload: Record<string, never> })
  | (Envelope & { type: 'ping'; roomId: string; payload: { seq: number; clientTime?: number } })
  | (Envelope & { type: 'pong'; roomId: string; payload: { seq: number; serverReceiveTime?: number; serverSendTime?: number } })
  | (Envelope & { type: 'lobby.settings'; roomId: string; payload: { sidePreference: SidePreference; timeControlId: TimeControlId } })
  | (Envelope & { type: 'lobby.lock'; roomId: string; payload: { locked: boolean } })
  | (Envelope & { type: 'lobby.ready'; roomId: string; payload: { ready: boolean; settingsVersion: number } })
  | (Envelope & { type: 'lobby.start'; roomId: string; payload: Record<string, never> })
  | (Envelope & {
      type: 'lobby.return';
      roomId: string;
      payload: { matchId: string; intent: 'return-lobby' | 'rematch' };
    })
  | (Envelope & {
      type: 'game.action';
      requestId: string;
      roomId: string;
      payload: { matchId: string; stepNumber: number; revision: number; action: MatchAction };
    })
  | (Envelope & {
      type: 'game.negotiate';
      requestId: string;
      roomId: string;
      payload: { matchId: string; revision: number; kind: 'undo' | 'draw' };
    })
  | (Envelope & {
      type: 'game.negotiate.reply';
      requestId: string;
      roomId: string;
      payload: { matchId: string; negotiationId: string; accept: boolean };
    })
  | (Envelope & {
      type: 'game.resign';
      requestId: string;
      roomId: string;
      payload: { matchId: string; revision: number };
    })
  | (Envelope & {
      type: 'game.sync';
      roomId: string;
      payload: { matchId?: string };
    })
  | (Envelope & {
      type: 'chat.phrase';
      requestId: string;
      roomId: string;
      payload: { matchId: string; phraseId: string };
    });

export interface LobbyRejection {
  code: LobbyRejectCode;
  message: string;
}

export type ServerMessage =
  | (Envelope & {
      type: 'welcome';
      roomId: string;
      payload: {
        roomId: string;
        memberId: string;
        role: Role;
        name: string;
        members: MemberSnapshot[];
        lobby: LobbyState;
        resumeToken?: string;
        game?: MatchSnapshot;
      };
    })
  | (Envelope & { type: 'members'; roomId: string; payload: { members: MemberSnapshot[] } })
  | (Envelope & { type: 'ping'; roomId: string; payload: { seq: number; serverTime?: number } })
  | (Envelope & {
      type: 'pong';
      roomId: string;
      payload: { seq: number; serverReceiveTime?: number; serverSendTime?: number; clientSendTime?: number };
    })
  | (Envelope & { type: 'lobby.state'; roomId: string; payload: { lobby: LobbyState } })
  | (Envelope & { type: 'lobby.rejected'; roomId: string; payload: LobbyRejection })
  | (Envelope & {
      type: 'game.clock';
      roomId: string;
      payload: {
        matchId: string;
        revision: number;
        sampleSeq: number;
        clock: MatchClockSnapshot;
      };
    })
  | (Envelope & {
      type: 'game.state';
      roomId: string;
      payload: {
        matchId: string;
        seed: number;
        stepNumber: number;
        revision?: number;
        state: GameStateSnapshot;
        actorMemberId?: string;
        action?: MatchAction;
        startParameters?: StartParameters;
        clock?: MatchClockSnapshot;
        settlement?: MatchSettlement | null;
        pendingNegotiation?: PendingNegotiation | null;
        drawCooldownUntil?: Record<string, number>;
        phraseCooldownUntil?: Record<string, number>;
        negotiationEvent?: NegotiationEvent | null;
        matchEvents?: MatchEvent[];
      };
    })
  | (Envelope & {
      type: 'game.rejected';
      roomId: string;
      payload: {
        matchId: string;
        stepNumber: number;
        reason: string;
        state: GameStateSnapshot;
      };
    })
  | (Envelope & {
      type: 'chat.phrase';
      roomId: string;
      payload: QuickPhraseEvent;
    })
  | (Envelope & {
      type: 'chat.phrase.rejected';
      roomId: string;
      requestId?: string;
      payload: QuickChatRejection;
    })
  | (Envelope & { type: 'room.closed'; roomId: string; payload: { reason: RoomClosedReason } })
  | (Envelope & { type: 'error'; roomId: string | null; payload: { code: ServerErrorCode; message: string } });

export type ParseResult<T> = { ok: true; message: T } | { ok: false; code: ServerErrorCode; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(raw: string): ParseResult<Envelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE', detail: 'not-json' };
  }

  if (!isRecord(parsed)) {
    return { ok: false, code: 'INVALID_MESSAGE', detail: 'not-object' };
  }

  const { version, type, requestId, roomId, payload } = parsed;

  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return { ok: false, code: 'INVALID_MESSAGE', detail: 'missing-version' };
  }
  if (version !== PROTOCOL_VERSION) {
    return { ok: false, code: 'VERSION_MISMATCH', detail: `version=${version}` };
  }
  if (typeof type !== 'string' || type.length === 0) {
    return { ok: false, code: 'INVALID_MESSAGE', detail: 'missing-type' };
  }
  if (requestId !== undefined && typeof requestId !== 'string') {
    return { ok: false, code: 'INVALID_MESSAGE', detail: 'bad-request-id' };
  }
  if (roomId !== null && typeof roomId !== 'string') {
    return { ok: false, code: 'INVALID_MESSAGE', detail: 'bad-room-id' };
  }
  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, code: 'INVALID_MESSAGE', detail: 'bad-payload' };
  }

  return {
    ok: true,
    message: {
      version,
      type,
      ...(typeof requestId === 'string' ? { requestId } : {}),
      roomId: roomId === null ? null : (roomId as string),
      payload: payload ?? {},
    },
  };
}

/** 解析客户端消息（服务端入口校验）。 */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const envelope = parseEnvelope(raw);
  if (!envelope.ok) {
    return envelope;
  }

  const message = envelope.message;

  if (message.type === 'hello') {
    const payload = message.payload as Record<string, unknown>;
    const role = payload.role;
    const name = payload.name;
    const token = payload.token;
    const resumeToken = payload.resumeToken;
    if (!isRole(role)) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'hello-role' };
    }
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'hello-name' };
    }
    if (token !== undefined && typeof token !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'hello-token' };
    }
    if (resumeToken !== undefined && typeof resumeToken !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'hello-resume-token' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'hello',
        payload: {
          role,
          name,
          ...(typeof token === 'string' ? { token } : {}),
          ...(typeof resumeToken === 'string' ? { resumeToken } : {}),
        },
      },
    };
  }

  if (message.type === 'ping' || message.type === 'pong') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: `${message.type}-room-id` };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.seq !== 'number' || !Number.isInteger(payload.seq) || payload.seq < 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: `${message.type}-seq` };
    }
    const clientTime =
      typeof payload.clientTime === 'number' && Number.isFinite(payload.clientTime) ? payload.clientTime : undefined;
    const serverReceiveTime =
      typeof payload.serverReceiveTime === 'number' && Number.isFinite(payload.serverReceiveTime)
        ? payload.serverReceiveTime
        : undefined;
    const serverSendTime =
      typeof payload.serverSendTime === 'number' && Number.isFinite(payload.serverSendTime)
        ? payload.serverSendTime
        : undefined;
    return {
      ok: true,
      message: {
        ...message,
        type: message.type,
        roomId: message.roomId,
        payload: {
          seq: payload.seq,
          ...(clientTime !== undefined ? { clientTime } : {}),
          ...(serverReceiveTime !== undefined ? { serverReceiveTime } : {}),
          ...(serverSendTime !== undefined ? { serverSendTime } : {}),
        },
      },
    };
  }

  if (message.type === 'leave') {
    if (typeof message.roomId !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'leave-room-id' };
    }
    return { ok: true, message: { ...message, type: 'leave', roomId: message.roomId, payload: {} } };
  }

  if (message.type === 'lobby.return') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-return-room-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-return-match-id' };
    }
    if (payload.intent !== 'return-lobby' && payload.intent !== 'rematch') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-return-intent' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'lobby.return',
        roomId: message.roomId,
        payload: { matchId: payload.matchId, intent: payload.intent },
      },
    };
  }

  if (message.type === 'lobby.settings') {
    const payload = message.payload as Record<string, unknown>;
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-settings-room-id' };
    }
    if (!isSidePreference(payload.sidePreference) || !isTimeControlId(payload.timeControlId)) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-settings-values' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'lobby.settings',
        roomId: message.roomId,
        payload: { sidePreference: payload.sidePreference, timeControlId: payload.timeControlId },
      },
    };
  }

  if (message.type === 'lobby.lock') {
    const payload = message.payload as Record<string, unknown>;
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-lock-room-id' };
    }
    if (typeof payload.locked !== 'boolean') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-lock-value' };
    }
    return { ok: true, message: { ...message, type: 'lobby.lock', roomId: message.roomId, payload: { locked: payload.locked } } };
  }

  if (message.type === 'lobby.ready') {
    const payload = message.payload as Record<string, unknown>;
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-ready-room-id' };
    }
    const { ready, settingsVersion } = payload;
    if (typeof ready !== 'boolean' || typeof settingsVersion !== 'number' || !Number.isInteger(settingsVersion) || settingsVersion < 1) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-ready-value' };
    }
    return {
      ok: true,
      message: { ...message, type: 'lobby.ready', roomId: message.roomId, payload: { ready, settingsVersion } },
    };
  }

  if (message.type === 'lobby.start') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-start-room-id' };
    }
    return { ok: true, message: { ...message, type: 'lobby.start', roomId: message.roomId, payload: {} } };
  }

  if (message.type === 'game.action') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-action-room-id' };
    }
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-action-request-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-action-match-id' };
    }
    if (
      typeof payload.stepNumber !== 'number' ||
      !Number.isInteger(payload.stepNumber) ||
      payload.stepNumber < 0 ||
      payload.stepNumber > Number.MAX_SAFE_INTEGER
    ) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-action-step-number' };
    }
    if (
      typeof payload.revision !== 'number' ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0
    ) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-action-revision' };
    }
    const action = parseMatchAction(payload.action);
    if (!action) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-action-action' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'game.action',
        requestId: message.requestId,
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          stepNumber: payload.stepNumber,
          revision: payload.revision,
          action,
        },
      },
    };
  }

  if (message.type === 'game.negotiate') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-room-id' };
    }
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-request-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-match-id' };
    }
    if (
      typeof payload.revision !== 'number' ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0
    ) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-revision' };
    }
    if (payload.kind !== 'undo' && payload.kind !== 'draw') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-kind' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'game.negotiate',
        requestId: message.requestId,
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          revision: payload.revision,
          kind: payload.kind,
        },
      },
    };
  }

  if (message.type === 'game.negotiate.reply') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-reply-room-id' };
    }
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-reply-request-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-reply-match-id' };
    }
    if (typeof payload.negotiationId !== 'string' || payload.negotiationId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-reply-negotiation-id' };
    }
    if (typeof payload.accept !== 'boolean') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-negotiate-reply-accept' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'game.negotiate.reply',
        requestId: message.requestId,
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          negotiationId: payload.negotiationId,
          accept: payload.accept,
        },
      },
    };
  }

  if (message.type === 'game.resign') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-resign-room-id' };
    }
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-resign-request-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-resign-match-id' };
    }
    if (
      typeof payload.revision !== 'number' ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0
    ) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-resign-revision' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'game.resign',
        requestId: message.requestId,
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          revision: payload.revision,
        },
      },
    };
  }

  if (message.type === 'game.sync') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-sync-room-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    const matchId = typeof payload.matchId === 'string' && payload.matchId.length > 0 ? payload.matchId : undefined;
    return {
      ok: true,
      message: {
        ...message,
        type: 'game.sync',
        roomId: message.roomId,
        payload: { ...(matchId ? { matchId } : {}) },
      },
    };
  }

  if (message.type === 'chat.phrase') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-room-id' };
    }
    if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-request-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-match-id' };
    }
    if (typeof payload.phraseId !== 'string' || payload.phraseId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-invalid-phrase-id' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'chat.phrase',
        requestId: message.requestId,
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          phraseId: payload.phraseId,
        },
      },
    };
  }

  return { ok: false, code: 'INVALID_MESSAGE', detail: `unknown-type=${message.type}` };
}

/** 解析服务端消息（客户端入口校验）。 */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const envelope = parseEnvelope(raw);
  if (!envelope.ok) {
    return envelope;
  }

  const message = envelope.message;

  if (message.type === 'welcome') {
    const payload = message.payload as Record<string, unknown>;
    if (typeof message.roomId !== 'string' || typeof payload.memberId !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'welcome-identity' };
    }
    if (!isRole(payload.role)) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'welcome-role' };
    }
    const members = parseMembers(payload.members);
    const lobby = parseLobbyState(payload.lobby);
    if (!members || !lobby) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'welcome-members' };
    }
    const game = payload.game !== undefined ? parseMatchSnapshot(payload.game) : undefined;
    if (payload.game !== undefined && !game) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'welcome-game' };
    }
    const defaultName = payload.role === 'host' ? '房主' : payload.role === 'guest' ? '客人' : '旁观';
    return {
      ok: true,
      message: {
        ...message,
        type: 'welcome',
        roomId: message.roomId,
        payload: {
          roomId: message.roomId,
          memberId: payload.memberId,
          role: payload.role,
          name: typeof payload.name === 'string' ? payload.name : defaultName,
          members,
          lobby,
          ...(typeof payload.resumeToken === 'string' ? { resumeToken: payload.resumeToken } : {}),
          ...(game ? { game } : {}),
        },
      },
    };
  }

  if (message.type === 'ping' || message.type === 'pong') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: `${message.type}-room-id` };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.seq !== 'number' || !Number.isInteger(payload.seq) || payload.seq < 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: `${message.type}-seq` };
    }
    const serverTime =
      typeof payload.serverTime === 'number' && Number.isFinite(payload.serverTime) ? payload.serverTime : undefined;
    const serverReceiveTime =
      typeof payload.serverReceiveTime === 'number' && Number.isFinite(payload.serverReceiveTime)
        ? payload.serverReceiveTime
        : undefined;
    const serverSendTime =
      typeof payload.serverSendTime === 'number' && Number.isFinite(payload.serverSendTime)
        ? payload.serverSendTime
        : undefined;
    return {
      ok: true,
      message: {
        ...message,
        type: message.type,
        roomId: message.roomId,
        payload: {
          seq: payload.seq,
          ...(serverTime !== undefined ? { serverTime } : {}),
          ...(serverReceiveTime !== undefined ? { serverReceiveTime } : {}),
          ...(serverSendTime !== undefined ? { serverSendTime } : {}),
        },
      },
    };
  }

  if (message.type === 'lobby.state') {
    const lobby = parseLobbyState((message.payload as Record<string, unknown>).lobby);
    if (!lobby || typeof message.roomId !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-state-payload' };
    }
    return { ok: true, message: { ...message, type: 'lobby.state', roomId: message.roomId, payload: { lobby } } };
  }

  if (message.type === 'lobby.rejected') {
    const payload = message.payload as Record<string, unknown>;
    const code = payload.code;
    if (!isLobbyRejectCode(code)) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'lobby-rejected-code' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'lobby.rejected',
        roomId: message.roomId ?? '',
        payload: { code, message: typeof payload.message === 'string' ? payload.message : '' },
      },
    };
  }

  if (message.type === 'members') {
    const members = parseMembers((message.payload as Record<string, unknown>).members);
    if (!members || typeof message.roomId !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'members-payload' };
    }
    return { ok: true, message: { ...message, type: 'members', roomId: message.roomId, payload: { members } } };
  }

  if (message.type === 'game.clock') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-clock-room-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-clock-match-id' };
    }
    if (typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-clock-revision' };
    }
    if (typeof payload.sampleSeq !== 'number' || !Number.isInteger(payload.sampleSeq) || payload.sampleSeq < 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-clock-sample-seq' };
    }
    const clock = parseMatchClockSnapshot(payload.clock);
    if (!clock) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-clock-clock' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'game.clock',
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          revision: payload.revision,
          sampleSeq: payload.sampleSeq,
          clock,
        },
      },
    };
  }

  if (message.type === 'game.state') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-state-room-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-state-match-id' };
    }
    if (
      typeof payload.seed !== 'number' ||
      !Number.isInteger(payload.seed) ||
      payload.seed < 0 ||
      payload.seed > 0xffffffff
    ) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-state-seed' };
    }
    if (
      typeof payload.stepNumber !== 'number' ||
      !Number.isSafeInteger(payload.stepNumber) ||
      payload.stepNumber < 0
    ) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-state-step-number' };
    }
    const revision =
      typeof payload.revision === 'number' && Number.isSafeInteger(payload.revision) && payload.revision >= 0
        ? payload.revision
        : 0;
    const state = parseGameStateSnapshot(payload.state);
    if (!state) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-state-state' };
    }
    const actorMemberId = typeof payload.actorMemberId === 'string' ? payload.actorMemberId : undefined;
    const action = payload.action ? parseMatchAction(payload.action) ?? undefined : undefined;
    const startParameters = payload.startParameters
      ? parseStartParameters(payload.startParameters) ?? undefined
      : undefined;
    const clock = payload.clock ? parseMatchClockSnapshot(payload.clock) ?? undefined : undefined;
    const settlement =
      payload.settlement !== undefined
        ? payload.settlement === null
          ? null
          : parseMatchSettlement(payload.settlement) ?? undefined
        : undefined;
    const pendingNegotiation =
      payload.pendingNegotiation !== undefined
        ? payload.pendingNegotiation === null
          ? null
          : parsePendingNegotiation(payload.pendingNegotiation) ?? undefined
        : undefined;
    const drawCooldownUntil = payload.drawCooldownUntil
      ? parseDrawCooldownUntil(payload.drawCooldownUntil) ?? undefined
      : undefined;
    const phraseCooldownUntil = payload.phraseCooldownUntil
      ? parsePhraseCooldownUntil(payload.phraseCooldownUntil) ?? undefined
      : undefined;
    const negotiationEvent =
      payload.negotiationEvent !== undefined
        ? payload.negotiationEvent === null
          ? null
          : parseNegotiationEvent(payload.negotiationEvent) ?? undefined
        : undefined;
    const matchEvents = Array.isArray(payload.matchEvents)
      ? parseMatchEvents(payload.matchEvents) ?? undefined
      : undefined;

    return {
      ok: true,
      message: {
        ...message,
        type: 'game.state',
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          seed: payload.seed,
          stepNumber: payload.stepNumber,
          revision,
          state,
          ...(actorMemberId ? { actorMemberId } : {}),
          ...(action ? { action } : {}),
          ...(startParameters ? { startParameters } : {}),
          ...(clock ? { clock } : {}),
          ...(settlement !== undefined ? { settlement } : {}),
          ...(pendingNegotiation !== undefined ? { pendingNegotiation } : {}),
          ...(drawCooldownUntil !== undefined ? { drawCooldownUntil } : {}),
          ...(phraseCooldownUntil !== undefined ? { phraseCooldownUntil } : {}),
          ...(negotiationEvent !== undefined ? { negotiationEvent } : {}),
          ...(matchEvents !== undefined ? { matchEvents } : {}),
        },
      },
    };
  }

  if (message.type === 'game.rejected') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-rejected-room-id' };
    }
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-rejected-match-id' };
    }
    if (
      typeof payload.stepNumber !== 'number' ||
      !Number.isInteger(payload.stepNumber) ||
      payload.stepNumber < 0 ||
      payload.stepNumber > Number.MAX_SAFE_INTEGER
    ) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-rejected-step-number' };
    }
    if (typeof payload.reason !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-rejected-reason' };
    }
    const state = parseGameStateSnapshot(payload.state);
    if (!state) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-rejected-state' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'game.rejected',
        roomId: message.roomId,
        payload: {
          matchId: payload.matchId,
          stepNumber: payload.stepNumber,
          reason: payload.reason,
          state,
        },
      },
    };
  }

  if (message.type === 'chat.phrase') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-room-id' };
    }
    const payload = parseQuickPhraseEvent(message.payload);
    if (!payload) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-payload' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'chat.phrase',
        roomId: message.roomId,
        payload,
      },
    };
  }

  if (message.type === 'chat.phrase.rejected') {
    if (typeof message.roomId !== 'string' || message.roomId.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-rejected-room-id' };
    }
    const payload = parseQuickChatRejection(message.payload);
    if (!payload) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'chat-phrase-rejected-payload' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'chat.phrase.rejected',
        roomId: message.roomId,
        ...(message.requestId ? { requestId: message.requestId } : {}),
        payload,
      },
    };
  }

  if (message.type === 'room.closed') {
    const reason = (message.payload as Record<string, unknown>).reason;
    if (reason !== 'host-closed' && reason !== 'host-disconnected' && reason !== 'server-stopped') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'room-closed-reason' };
    }
    return {
      ok: true,
      message: { ...message, type: 'room.closed', roomId: message.roomId ?? '', payload: { reason } },
    };
  }

  if (message.type === 'error') {
    const payload = message.payload as Record<string, unknown>;
    const code = payload.code;
    if (!isServerErrorCode(code)) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'error-code' };
    }
    return {
      ok: true,
      message: {
        ...message,
        type: 'error',
        payload: { code, message: typeof payload.message === 'string' ? payload.message : '' },
      },
    };
  }

  return { ok: false, code: 'INVALID_MESSAGE', detail: `unknown-type=${message.type}` };
}

export function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return (
    value === 'INVALID_MESSAGE' ||
    value === 'VERSION_MISMATCH' ||
    value === 'UNAUTHORIZED' ||
    value === 'ROOM_FULL' ||
    value === 'ROOM_CLOSED' ||
    value === 'HANDSHAKE_TIMEOUT' ||
    value === 'INTERNAL_ERROR'
  );
}

export function isLobbyRejectCode(value: unknown): value is LobbyRejectCode {
  return (
    value === 'NOT_HOST' ||
    value === 'LOCKED' ||
    value === 'INVALID_VALUE' ||
    value === 'STALE_VERSION' ||
    value === 'NOT_READY' ||
    value === 'MEMBER_MISSING' ||
    value === 'ALREADY_STARTED' ||
    value === 'SPECTATOR_READONLY'
  );
}

function parseMembers(value: unknown): MemberSnapshot[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const members: MemberSnapshot[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const { id, role, name, connected, leaveReason } = entry;
    if (typeof id !== 'string' || !isRole(role) || typeof name !== 'string' || typeof connected !== 'boolean') {
      return null;
    }
    if (leaveReason !== undefined && leaveReason !== 'left' && leaveReason !== 'dropped') {
      return null;
    }
    members.push({ id, role, name, connected, ...(leaveReason ? { leaveReason } : {}) });
  }
  return members;
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function buildClientHello(input: {
  role: Role;
  name: string;
  token?: string;
  resumeToken?: string;
  roomId?: string | null;
}): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'hello',
    roomId: input.roomId ?? null,
    payload: {
      role: input.role,
      name: input.name,
      ...(input.token ? { token: input.token } : {}),
      ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
    },
  };
}

export function buildPing(
  roomId: string,
  seq: number,
  timing?: { clientTime?: number; serverTime?: number },
): ClientMessage & ServerMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'ping',
    roomId,
    payload: {
      seq,
      ...(timing?.clientTime !== undefined ? { clientTime: timing.clientTime } : {}),
      ...(timing?.serverTime !== undefined ? { serverTime: timing.serverTime } : {}),
    },
  };
}

export function buildPong(
  roomId: string,
  seq: number,
  timing?: { serverReceiveTime?: number; serverSendTime?: number },
): ClientMessage & ServerMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'pong',
    roomId,
    payload: {
      seq,
      ...(timing?.serverReceiveTime !== undefined ? { serverReceiveTime: timing.serverReceiveTime } : {}),
      ...(timing?.serverSendTime !== undefined ? { serverSendTime: timing.serverSendTime } : {}),
    },
  };
}

export function buildClientLeave(roomId: string): ClientMessage {
  return { version: PROTOCOL_VERSION, type: 'leave', roomId, payload: {} };
}

export function buildClientLobbyReturn(
  roomId: string,
  payload: { matchId: string; intent: 'return-lobby' | 'rematch' },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'lobby.return',
    roomId,
    payload,
  };
}

export function buildServerGameClock(
  roomId: string,
  payload: { matchId: string; revision: number; sampleSeq: number; clock: MatchClockSnapshot },
): ServerMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'game.clock',
    roomId,
    payload,
  };
}

export function buildClientLobbySettings(
  roomId: string,
  input: { sidePreference: SidePreference; timeControlId: TimeControlId },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'lobby.settings',
    roomId,
    payload: { sidePreference: input.sidePreference, timeControlId: input.timeControlId },
  };
}

export function buildClientLobbyLock(roomId: string, locked: boolean): ClientMessage {
  return { version: PROTOCOL_VERSION, type: 'lobby.lock', roomId, payload: { locked } };
}

export function buildClientLobbyReady(roomId: string, ready: boolean, settingsVersion: number): ClientMessage {
  return { version: PROTOCOL_VERSION, type: 'lobby.ready', roomId, payload: { ready, settingsVersion } };
}

export function buildClientLobbyStart(roomId: string): ClientMessage {
  return { version: PROTOCOL_VERSION, type: 'lobby.start', roomId, payload: {} };
}

export function buildClientGameAction(
  roomId: string,
  input: { requestId: string; matchId: string; stepNumber: number; revision?: number; action: MatchAction },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'game.action',
    requestId: input.requestId,
    roomId,
    payload: {
      matchId: input.matchId,
      stepNumber: input.stepNumber,
      revision: input.revision ?? 0,
      action: input.action,
    },
  };
}

export function buildClientGameNegotiate(
  roomId: string,
  input: { requestId: string; matchId: string; revision: number; kind: 'undo' | 'draw' },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'game.negotiate',
    requestId: input.requestId,
    roomId,
    payload: {
      matchId: input.matchId,
      revision: input.revision,
      kind: input.kind,
    },
  };
}

export function buildClientGameNegotiateReply(
  roomId: string,
  input: { requestId: string; matchId: string; negotiationId: string; accept: boolean },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'game.negotiate.reply',
    requestId: input.requestId,
    roomId,
    payload: {
      matchId: input.matchId,
      negotiationId: input.negotiationId,
      accept: input.accept,
    },
  };
}

export function buildClientGameResign(
  roomId: string,
  input: { requestId: string; matchId: string; revision: number },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'game.resign',
    requestId: input.requestId,
    roomId,
    payload: {
      matchId: input.matchId,
      revision: input.revision,
    },
  };
}

export function buildClientGameSync(
  roomId: string,
  matchId?: string,
  requestId?: string,
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'game.sync',
    roomId,
    ...(requestId ? { requestId } : {}),
    payload: { ...(matchId ? { matchId } : {}) },
  };
}

export function buildClientChatPhrase(
  roomId: string,
  input: { requestId: string; matchId: string; phraseId: string },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'chat.phrase',
    requestId: input.requestId,
    roomId,
    payload: {
      matchId: input.matchId,
      phraseId: input.phraseId,
    },
  };
}

export function buildServerChatPhrase(roomId: string, payload: QuickPhraseEvent): ServerMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'chat.phrase',
    roomId,
    payload,
  };
}

export function buildServerChatPhraseRejected(
  roomId: string,
  payload: QuickChatRejection,
  requestId?: string,
): ServerMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'chat.phrase.rejected',
    roomId,
    ...(requestId ? { requestId } : {}),
    payload,
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function buildServerMessage(message: DistributiveOmit<ServerMessage, 'version'>): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, ...message });
}
