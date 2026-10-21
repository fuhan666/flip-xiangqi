// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RoomManager } from '../room-manager';
import { asIdentityId } from '../room-identity';

const owner = asIdentityId('owner-identity');
const other = asIdentityId('other-identity');

function createManager(): RoomManager {
  let counter = 0;
  return new RoomManager({
    logger: () => undefined,
    generateRoomId: () => `room-${(counter += 1).toString().padStart(4, '0')}`,
  });
}

describe('在线房间注册表', () => {
  it('同一身份的同一 requestId 只创建一个房间', () => {
    const manager = createManager();
    const first = manager.createRoom({ identityId: owner, requestId: 'req-1' });
    const retry = manager.createRoom({ identityId: owner, requestId: 'req-1' });

    expect(first.ok && first.created).toBe(true);
    expect(retry.ok && retry.created).toBe(false);
    if (first.ok && retry.ok) {
      expect(retry.roomId).toBe(first.roomId);
    }
    expect(manager.roomCount).toBe(1);
  });

  it('不同身份用同名 requestId 各自建房，房间互相隔离', () => {
    const manager = createManager();
    const a = manager.createRoom({ identityId: owner, requestId: 'same' });
    const b = manager.createRoom({ identityId: other, requestId: 'same' });

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.roomId).not.toBe(b.roomId);
    }
    expect(manager.roomCount).toBe(2);
  });

  it('同键不同参数按冲突拒绝，不产生第二个房间', () => {
    const manager = createManager();
    const first = manager.createRoom({ identityId: owner, requestId: 'req', fingerprint: 'a' });
    expect(first.ok).toBe(true);

    const conflict = manager.createRoom({ identityId: owner, requestId: 'req', fingerprint: 'b' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe('REQUEST_CONFLICT');
    }
    expect(manager.roomCount).toBe(1);
  });

  it('关闭房间后同键重试返回已关闭结果，不会复活房间', () => {
    const manager = createManager();
    const created = manager.createRoom({ identityId: owner, requestId: 'req' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(manager.closeRoom(created.roomId)).toBe(true);
    expect(manager.get(created.roomId)).toBeNull();
    expect(manager.roomCount).toBe(0);

    const retry = manager.createRoom({ identityId: owner, requestId: 'req' });
    expect(retry.ok && retry.created).toBe(false);
    expect(retry.ok && retry.closed).toBe(true);
    if (retry.ok) {
      expect(retry.roomId).toBe(created.roomId);
    }
    expect(manager.roomCount).toBe(0);
  });

  it('只有建房者身份能关闭自己的房间', () => {
    const manager = createManager();
    const created = manager.createRoom({ identityId: owner, requestId: 'req' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(manager.closeOwnRoom(created.roomId, other)).toBe(false);
    expect(manager.get(created.roomId)).not.toBeNull();
    expect(manager.closeOwnRoom(created.roomId, owner)).toBe(true);
    expect(manager.get(created.roomId)).toBeNull();
  });

  it('停止服务关闭全部房间并清空注册表（幂等）', () => {
    const manager = createManager();
    const a = manager.createRoom({ identityId: owner, requestId: 'a' });
    const b = manager.createRoom({ identityId: owner, requestId: 'b' });
    expect(a.ok && b.ok).toBe(true);

    const sessions = [a, b].flatMap((result) => (result.ok ? [manager.get(result.roomId)!] : []));
    manager.stop();
    manager.stop();

    expect(sessions.every((session) => session.isClosed)).toBe(true);
    expect(manager.roomCount).toBe(0);
    expect(() => manager.createRoom({ identityId: owner, requestId: 'c' })).toThrow();
  });

  it('房间号不可枚举且不重复', () => {
    const manager = new RoomManager({ logger: () => undefined });
    const ids = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const result = manager.createRoom({ identityId: owner, requestId: `req-${index}` });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.roomId).toMatch(/^[A-Za-z0-9_-]{16}$/);
        ids.add(result.roomId);
      }
    }
    expect(ids.size).toBe(20);
  });
});
