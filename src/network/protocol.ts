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
  parseMatchSnapshot,
  type MatchAction,
  type MatchSnapshot,
} from './match.js';
import type { GameStateSnapshot } from '../game/index.js';

// 线格式使用的领域类型从协议入口统一再导出，调用方无需两个导入源。
export type { LobbyRejectCode, LobbyState, SidePreference, StartParameters, TimeControlId } from './lobby.js';
export type { MatchAction, MatchSnapshot } from './match.js';

/** v3：增加 game.action、game.state、game.rejected、game.sync 权威对局协议。 */
export const PROTOCOL_VERSION = 3;

/** WebSocket 握手路径（房间服务同时在该路径上提供客人页面）。 */
export const WS_PATH = '/ws';

export type Role = 'host' | 'guest';

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
  payload?: Record<string, unknown>;
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
  | (Envelope & { type: 'ping'; roomId: string; payload: { seq: number } })
  | (Envelope & { type: 'pong'; roomId: string; payload: { seq: number } })
  | (Envelope & { type: 'lobby.settings'; roomId: string; payload: { sidePreference: SidePreference; timeControlId: TimeControlId } })
  | (Envelope & { type: 'lobby.lock'; roomId: string; payload: { locked: boolean } })
  | (Envelope & { type: 'lobby.ready'; roomId: string; payload: { ready: boolean; settingsVersion: number } })
  | (Envelope & { type: 'lobby.start'; roomId: string; payload: Record<string, never> })
  | (Envelope & {
      type: 'game.action';
      requestId: string;
      roomId: string;
      payload: { matchId: string; stepNumber: number; action: MatchAction };
    })
  | (Envelope & {
      type: 'game.sync';
      roomId: string;
      payload: { matchId?: string };
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
  | (Envelope & { type: 'ping'; roomId: string; payload: { seq: number } })
  | (Envelope & { type: 'pong'; roomId: string; payload: { seq: number } })
  | (Envelope & { type: 'lobby.state'; roomId: string; payload: { lobby: LobbyState } })
  | (Envelope & { type: 'lobby.rejected'; roomId: string; payload: LobbyRejection })
  | (Envelope & {
      type: 'game.state';
      roomId: string;
      payload: {
        matchId: string;
        seed: number;
        stepNumber: number;
        state: GameStateSnapshot;
        actorMemberId?: string;
        action?: MatchAction;
        startParameters?: StartParameters;
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
    if (role !== 'host' && role !== 'guest') {
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
    return {
      ok: true,
      message: { ...message, type: message.type, roomId: message.roomId, payload: { seq: payload.seq } },
    };
  }

  if (message.type === 'leave') {
    if (typeof message.roomId !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'leave-room-id' };
    }
    return { ok: true, message: { ...message, type: 'leave', roomId: message.roomId, payload: {} } };
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
          action,
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
    if (payload.role !== 'host' && payload.role !== 'guest') {
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
          name: typeof payload.name === 'string' ? payload.name : payload.role === 'host' ? '房主' : '客人',
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
    return {
      ok: true,
      message: { ...message, type: message.type, roomId: message.roomId, payload: { seq: payload.seq } },
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
    const state = parseGameStateSnapshot(payload.state);
    if (!state) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'game-state-state' };
    }
    const actorMemberId = typeof payload.actorMemberId === 'string' ? payload.actorMemberId : undefined;
    const action = payload.action ? parseMatchAction(payload.action) ?? undefined : undefined;
    const startParameters = payload.startParameters
      ? parseStartParameters(payload.startParameters) ?? undefined
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
          state,
          ...(actorMemberId ? { actorMemberId } : {}),
          ...(action ? { action } : {}),
          ...(startParameters ? { startParameters } : {}),
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
    value === 'ALREADY_STARTED'
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
    if (typeof id !== 'string' || (role !== 'host' && role !== 'guest') || typeof name !== 'string' || typeof connected !== 'boolean') {
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

export function buildPing(roomId: string, seq: number): ClientMessage & ServerMessage {
  return { version: PROTOCOL_VERSION, type: 'ping', roomId, payload: { seq } };
}

export function buildPong(roomId: string, seq: number): ClientMessage & ServerMessage {
  return { version: PROTOCOL_VERSION, type: 'pong', roomId, payload: { seq } };
}

export function buildClientLeave(roomId: string): ClientMessage {
  return { version: PROTOCOL_VERSION, type: 'leave', roomId, payload: {} };
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
  input: { requestId: string; matchId: string; stepNumber: number; action: MatchAction },
): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'game.action',
    requestId: input.requestId,
    roomId,
    payload: {
      matchId: input.matchId,
      stepNumber: input.stepNumber,
      action: input.action,
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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function buildServerMessage(message: DistributiveOmit<ServerMessage, 'version'>): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, ...message });
}
