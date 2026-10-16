/**
 * 连接层协议：客户端与宿主共用的封包格式、握手消息、错误码与校验逻辑。
 *
 * 该文件必须保持纯 TypeScript（不依赖 Node API 与 DOM API），
 * 以便同时被浏览器客户端与 Node 宿主服务引用。
 */

export const PROTOCOL_VERSION = 1;

/** WebSocket 握手路径（房间服务同时在该路径上提供客人页面）。 */
export const WS_PATH = '/ws';

export type Role = 'host' | 'guest';

export interface MemberSnapshot {
  id: string;
  role: Role;
  name: string;
  connected: boolean;
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
}

export type ClientMessage =
  | (Envelope & { type: 'hello'; roomId: null | string; payload: HelloPayload })
  | (Envelope & { type: 'leave'; roomId: string; payload: Record<string, never> });

export type ServerMessage =
  | (Envelope & {
      type: 'welcome';
      roomId: string;
      payload: { roomId: string; memberId: string; role: Role; name: string; members: MemberSnapshot[] };
    })
  | (Envelope & { type: 'members'; roomId: string; payload: { members: MemberSnapshot[] } })
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
    if (role !== 'host' && role !== 'guest') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'hello-role' };
    }
    if (typeof name !== 'string' || name.length === 0) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'hello-name' };
    }
    if (token !== undefined && typeof token !== 'string') {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'hello-token' };
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
    if (!members) {
      return { ok: false, code: 'INVALID_MESSAGE', detail: 'welcome-members' };
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
        },
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

function parseMembers(value: unknown): MemberSnapshot[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const members: MemberSnapshot[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const { id, role, name, connected } = entry;
    if (typeof id !== 'string' || (role !== 'host' && role !== 'guest') || typeof name !== 'string' || typeof connected !== 'boolean') {
      return null;
    }
    members.push({ id, role, name, connected });
  }
  return members;
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export function buildClientHello(input: { role: Role; name: string; token?: string; roomId?: string | null }): ClientMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'hello',
    roomId: input.roomId ?? null,
    payload: {
      role: input.role,
      name: input.name,
      ...(input.token ? { token: input.token } : {}),
    },
  };
}

export function buildClientLeave(roomId: string): ClientMessage {
  return { version: PROTOCOL_VERSION, type: 'leave', roomId, payload: {} };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function buildServerMessage(message: DistributiveOmit<ServerMessage, 'version'>): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, ...message });
}
