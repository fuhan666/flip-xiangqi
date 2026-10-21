/**
 * 房间身份模型：用户身份 / 成员席位 / 当前连接 三层分离。
 *
 * - 身份（identity）：由服务端生成或可信解析，客户端不得自报账号身份；
 *   当前只有匿名身份，账号接入通过 {@link IdentityResolver} 预留。
 * - 成员席位（member）：承载 host/guest/spectator 角色与恢复凭据；
 *   重连保持身份与席位，只替换连接。
 * - 连接（connection）：只代表一次传输层连接；迟到消息与 close 回调必须携带
 *   原连接标识，不能操作或下线新连接。
 */
import { randomBytes } from 'node:crypto';
import type { MemberLeaveReason, Role } from '../src/network/protocol.js';

/** 用户身份标识：由服务端生成或可信解析，与 memberId / connectionId 互不通用。 */
export type IdentityId = string & { readonly __brand: 'IdentityId' };

/** 房间成员席位标识：对局执色（redMemberId / blackMemberId）冻结时引用它。 */
export type MemberId = string & { readonly __brand: 'MemberId' };

/** 连接标识：一次传输层连接的不透明标识，重连即更换。 */
export type ConnectionId = string & { readonly __brand: 'ConnectionId' };

export function asIdentityId(value: string): IdentityId {
  return value as IdentityId;
}

export function asMemberId(value: string): MemberId {
  return value as MemberId;
}

export function asConnectionId(value: string): ConnectionId {
  return value as ConnectionId;
}

export function generateToken(): string {
  return randomBytes(16).toString('hex');
}

export function generateId(): string {
  return randomBytes(8).toString('hex');
}

/** 身份种类：当前只发匿名身份；账号接入后由可信解析器给出 account。 */
export type IdentityKind = 'anonymous' | 'account';

export interface RoomIdentity {
  readonly identityId: IdentityId;
  readonly kind: IdentityKind;
  readonly displayName: string;
}

export interface IdentityHint {
  role: Role;
  /** 客户端 hello 自报的展示名仅作提示，不作为身份或命名依据。 */
  requestedName?: string;
}

/**
 * 身份解析：服务端生成或可信解析用户身份。
 * 未来的账号接入在此解析，客户端自报的账号信息一律不得采信。
 */
export type IdentityResolver = (hint: IdentityHint) => RoomIdentity;

/** 默认解析器：发匿名身份，展示名按席位角色给出。 */
export function createAnonymousIdentityResolver(newId: () => string = generateId): IdentityResolver {
  return (hint) => ({
    identityId: asIdentityId(newId()),
    kind: 'anonymous',
    displayName: hint.role === 'host' ? '房主' : hint.role === 'guest' ? '客人' : '旁观',
  });
}

/** 房间成员席位记录：持有身份、角色、恢复凭据与「当前连接」，不持有具体传输对象。 */
export interface RoomMemberRecord {
  readonly memberId: MemberId;
  /** 服务端生成或可信解析的用户身份；重连保持身份与席位不变。 */
  readonly identity: RoomIdentity;
  readonly role: Role;
  name: string;
  /** 当前连接：重连保持身份与席位、仅替换连接；离线时为 null。 */
  connectionId: ConnectionId | null;
  connected: boolean;
  leaveReason: MemberLeaveReason | null;
  /** 旁观者独立恢复凭据；host/guest 沿用 host token / 全局 guest resumeToken。 */
  resumeToken?: string;
}
