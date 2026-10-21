// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_COOKIE_NAME,
  AnonymousSessionStore,
  buildAnonymousCookie,
  readCookie,
} from '../anonymous-session';

describe('匿名会话凭据', () => {
  it('签发不可枚举凭据并只按摘要解析出同一可信身份', () => {
    const store = new AnonymousSessionStore();
    const first = store.issue();
    const second = store.issue();

    expect(first.token.length).toBeGreaterThanOrEqual(40);
    expect(first.token).not.toBe(second.token);
    expect(first.identity.identityId).not.toBe(second.identity.identityId);
    expect(first.identity.kind).toBe('anonymous');
    // 凭据本身不携带身份标识：即使泄漏也无法与身份对应。
    expect(first.token).not.toContain(first.identity.identityId);

    expect(store.resolve(first.token)?.identityId).toBe(first.identity.identityId);
    expect(store.resolve(second.token)?.identityId).toBe(second.identity.identityId);
    expect(store.size).toBe(2);
  });

  it('拒绝缺失、伪造与已撤销的凭据', () => {
    const store = new AnonymousSessionStore();
    const issued = store.issue();

    expect(store.resolve(null)).toBeNull();
    expect(store.resolve(undefined)).toBeNull();
    expect(store.resolve('')).toBeNull();
    expect(store.resolve('short')).toBeNull();
    expect(store.resolve('A'.repeat(64))).toBeNull();

    store.revoke(issued.token);
    expect(store.resolve(issued.token)).toBeNull();

    const afterReset = store.issue();
    store.clear();
    expect(store.resolve(afterReset.token)).toBeNull();
  });

  it('cookie 只按 HttpOnly/Secure/SameSite 下发，且不带 Domain', () => {
    const cookie = buildAnonymousCookie('token-value');
    expect(cookie.startsWith(`${ANONYMOUS_COOKIE_NAME}=token-value;`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
    expect(ANONYMOUS_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  it('从 Cookie 头读取指定名称的凭据', () => {
    const header = `other=1; ${ANONYMOUS_COOKIE_NAME}=abc123; later=2`;
    expect(readCookie(header, ANONYMOUS_COOKIE_NAME)).toBe('abc123');
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(undefined, ANONYMOUS_COOKIE_NAME)).toBeNull();
    expect(readCookie(`${ANONYMOUS_COOKIE_NAME}=`, ANONYMOUS_COOKIE_NAME)).toBeNull();
  });
});
