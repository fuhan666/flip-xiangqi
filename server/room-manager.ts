/**
 * 在线房间注册表（RoomManager）：一个进程内按 roomId 注册与路由多个房间。
 *
 * - 每个房间仍由一个 RoomSession 持有全部权威状态（大厅/对局/计时/成员），
 *   本管理器不复制任何对局状态，只负责寻址、建房幂等与关闭；
 * - 建房请求按 (identityId, requestId) 幂等：同键重复提交得到同一 roomId，
 *   同键不同参数或已被关闭的房间不会复活，也不会产生第二个房间；
 * - 关闭单个房间只清理该房间，不影响共享监听器与其他房间。
 */
import { randomBytes } from 'node:crypto';
import type { RoomClosedReason } from '../src/network/protocol.js';
import type { Logger } from './log.js';
import { defaultLogger } from './log.js';
import type { IdentityId } from './room-identity.js';
import { RoomSession } from './room-session.js';

export interface RoomManagerOptions {
  logger?: Logger;
  /** 房间号生成器；默认 96 bit 随机值，避免被枚举。 */
  generateRoomId?: () => string;
  /** 会话工厂（测试可注入受控时钟/随机源）。 */
  createSession?: (options: { roomId: string; ownerIdentityId: IdentityId }) => RoomSession;
}

export interface CreateRoomInput {
  identityId: IdentityId;
  requestId: string;
  /** 建房参数指纹；同一请求键携带不同参数视为冲突。 */
  fingerprint?: string;
}

export type CreateRoomResult =
  | { ok: true; roomId: string; created: boolean; closed: boolean }
  | { ok: false; code: 'REQUEST_CONFLICT'; message: string };

interface RoomEntry {
  session: RoomSession;
  ownerIdentityId: IdentityId;
  closed: boolean;
}

interface RequestRecord {
  roomId: string;
  fingerprint: string;
}

function defaultRoomId(): string {
  // 12 字节随机值 → 16 字符 base64url，不可枚举、不携带任何权限信息。
  return randomBytes(12).toString('base64url');
}

function requestKey(identityId: IdentityId, requestId: string): string {
  return `${identityId}\u0000${requestId}`;
}

export class RoomManager {
  private readonly logger: Logger;
  private readonly generateRoomId: () => string;
  private readonly createSession: (options: { roomId: string; ownerIdentityId: IdentityId }) => RoomSession;
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly requests = new Map<string, RequestRecord>();
  private stopped = false;

  constructor(options: RoomManagerOptions = {}) {
    this.logger = options.logger ?? defaultLogger;
    this.generateRoomId = options.generateRoomId ?? defaultRoomId;
    this.createSession =
      options.createSession ??
      ((sessionOptions) =>
        new RoomSession({
          roomId: sessionOptions.roomId,
          mode: 'online',
          ownerIdentityId: sessionOptions.ownerIdentityId,
          logger: this.logger,
          onClose: () => this.markClosed(sessionOptions.roomId),
        }));
  }

  get roomCount(): number {
    let count = 0;
    for (const entry of this.rooms.values()) {
      if (!entry.closed) {
        count += 1;
      }
    }
    return count;
  }

  /** 幂等建房：同 (identityId, requestId) 只创建一次，返回同一 roomId。 */
  createRoom(input: CreateRoomInput): CreateRoomResult {
    if (this.stopped) {
      throw new Error('房间服务已停止');
    }
    if (input.requestId.length === 0) {
      throw new Error('建房请求必须携带 requestId');
    }
    const fingerprint = input.fingerprint ?? '';
    const key = requestKey(input.identityId, input.requestId);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return { ok: false, code: 'REQUEST_CONFLICT', message: '同一请求编号不能用于不同的建房参数' };
      }
      const entry = this.rooms.get(previous.roomId);
      return { ok: true, roomId: previous.roomId, created: false, closed: entry?.closed ?? true };
    }

    const roomId = this.uniqueRoomId();
    const session = this.createSession({ roomId, ownerIdentityId: input.identityId });
    this.rooms.set(roomId, { session, ownerIdentityId: input.identityId, closed: false });
    this.requests.set(key, { roomId, fingerprint });
    this.logger('online.room_created', { room: roomId });
    return { ok: true, roomId, created: true, closed: false };
  }

  get(roomId: string): RoomSession | null {
    const entry = this.rooms.get(roomId);
    if (!entry || entry.closed) {
      return null;
    }
    return entry.session;
  }

  /** 关闭单个房间（幂等）；返回是否发生了关闭。 */
  closeRoom(roomId: string, reason: RoomClosedReason = 'host-closed'): boolean {
    const entry = this.rooms.get(roomId);
    if (!entry || entry.closed) {
      return false;
    }
    entry.closed = true;
    entry.session.close(reason);
    this.logger('online.room_closed', { room: roomId, reason });
    return true;
  }

  /** 显式关房入口（仅建房者身份可关闭自己创建的房间）。 */
  closeOwnRoom(roomId: string, identityId: IdentityId, reason: RoomClosedReason = 'host-closed'): boolean {
    const entry = this.rooms.get(roomId);
    if (!entry || entry.closed || entry.ownerIdentityId !== identityId) {
      return false;
    }
    return this.closeRoom(roomId, reason);
  }

  /** 停止服务：关闭全部房间、释放领域定时器，并清空注册表（幂等）。 */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const [roomId, entry] of [...this.rooms.entries()]) {
      if (!entry.closed) {
        entry.closed = true;
        entry.session.close('server-stopped');
      }
      this.logger('online.room_closed', { room: roomId, reason: 'server-stopped' });
    }
    this.rooms.clear();
    this.requests.clear();
  }

  private markClosed(roomId: string): void {
    const entry = this.rooms.get(roomId);
    if (entry) {
      entry.closed = true;
    }
  }

  private uniqueRoomId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.generateRoomId();
      if (!this.rooms.has(candidate)) {
        return candidate;
      }
    }
    throw new Error('无法生成唯一房间号');
  }
}
