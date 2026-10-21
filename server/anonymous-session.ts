/**
 * 匿名会话（在线入口）：服务器签发并校验的不透明凭据，用来解析用户身份。
 *
 * - 凭据由密码学随机值生成（256 bit），只在内存保存 SHA-256 摘要，进程重启即失效；
 * - 浏览器通过同源 `HttpOnly` cookie 携带，JS 无法读取，也不进入 URL、localStorage
 *   或任何 API JSON；
 * - 用户身份（identityId）只来自这里；房间成员席位与连接标识仍由 RoomSession 独立持有，
 *   客户端自报的 identityId / memberId / role / token 一律不采信。
 */
import { createHash, randomBytes } from 'node:crypto';
import { asIdentityId, type RoomIdentity } from './room-identity.js';

/** `__Host-` 前缀要求 Secure + Path=/ 且不带 Domain，避免子域覆盖。 */
export const ANONYMOUS_COOKIE_NAME = '__Host-flip_anon';

const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Lax; Secure';
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

export interface AnonymousSessionStoreOptions {
  /** 凭据生成（测试可注入确定值）。 */
  randomToken?: () => string;
  /** 身份标识生成（测试可注入确定值）。 */
  randomIdentityId?: () => string;
}

export interface IssuedAnonymousSession {
  /** 交给浏览器的凭据明文：只写进 Set-Cookie，不进日志与响应体。 */
  token: string;
  identity: RoomIdentity;
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function defaultToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function defaultIdentityId(): string {
  return randomBytes(12).toString('base64url');
}

export class AnonymousSessionStore {
  private readonly randomToken: () => string;
  private readonly randomIdentityId: () => string;
  /** 凭据摘要 → 可信身份：不保存明文凭据。 */
  private readonly sessions = new Map<string, RoomIdentity>();

  constructor(options: AnonymousSessionStoreOptions = {}) {
    this.randomToken = options.randomToken ?? defaultToken;
    this.randomIdentityId = options.randomIdentityId ?? defaultIdentityId;
  }

  get size(): number {
    return this.sessions.size;
  }

  issue(): IssuedAnonymousSession {
    const token = this.randomToken();
    if (!TOKEN_PATTERN.test(token)) {
      throw new Error('匿名凭据生成结果不符合不可枚举要求');
    }
    const identity: RoomIdentity = {
      identityId: asIdentityId(this.randomIdentityId()),
      kind: 'anonymous',
      displayName: '匿名玩家',
    };
    this.sessions.set(digest(token), identity);
    return { token, identity };
  }

  /** 解析凭据：缺失、格式不符或未签发过一律返回 null（调用方按 401 处理）。 */
  resolve(token: string | null | undefined): RoomIdentity | null {
    if (!token || !TOKEN_PATTERN.test(token)) {
      return null;
    }
    return this.sessions.get(digest(token)) ?? null;
  }

  revoke(token: string | null | undefined): void {
    if (!token) {
      return;
    }
    this.sessions.delete(digest(token));
  }

  clear(): void {
    this.sessions.clear();
  }
}

/** 读取指定名称的 cookie（同名取第一个）。 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** 签发 cookie：Secure + HttpOnly + SameSite=Lax + Path=/，不带 Domain。 */
export function buildAnonymousCookie(token: string): string {
  return `${ANONYMOUS_COOKIE_NAME}=${token}; ${COOKIE_ATTRIBUTES}`;
}
