/**
 * 「最近房间」本地持久化：localStorage 保存最近 5 条连接地址。
 * 存储损坏或不可用时静默降级，绝不阻断连接流程。
 */

export interface RecentRoom {
  address: string;
  savedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RECENT_ROOMS_KEY = 'flip-xiangqi.recent-rooms';
export const RECENT_ROOMS_LIMIT = 5;

function fallbackStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => undefined,
  };
}

export function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    // localStorage 在部分浏览器策略下会直接抛错。
  }
  return fallbackStorage();
}

export function loadRecentRooms(storage: StorageLike = defaultStorage()): RecentRoom[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(RECENT_ROOMS_KEY);
  } catch {
    return [];
  }

  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const rooms: RecentRoom[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const record = entry as { address?: unknown; savedAt?: unknown };
      if (typeof record.address !== 'string' || record.address.trim().length === 0) {
        continue;
      }
      rooms.push({
        address: record.address.trim(),
        savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
      });
    }
    return rooms.slice(0, RECENT_ROOMS_LIMIT);
  } catch {
    return [];
  }
}

/** 成功握手后调用：按地址去重、最新在前、最多 5 条。 */
export function rememberRoom(
  address: string,
  savedAt: number = Date.now(),
  storage: StorageLike = defaultStorage(),
): RecentRoom[] {
  const normalized = address.trim();
  const existing = loadRecentRooms(storage).filter((room) => room.address !== normalized);
  const rooms = [{ address: normalized, savedAt }, ...existing].slice(0, RECENT_ROOMS_LIMIT);

  try {
    storage.setItem(RECENT_ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    // 存储不可用（隐私模式/配额）时保持连接流程不受影响。
  }

  return rooms;
}

export function clearRecentRooms(storage: StorageLike = defaultStorage()): RecentRoom[] {
  try {
    storage.setItem(RECENT_ROOMS_KEY, '[]');
  } catch {
    // 忽略：仅清空展示。
  }
  return [];
}
