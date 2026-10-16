import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentRooms,
  loadRecentRooms,
  rememberRoom,
  RECENT_ROOMS_KEY,
  RECENT_ROOMS_LIMIT,
  type StorageLike,
} from '../recent-rooms';

function memoryStorage(initial?: Record<string, string>): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('recent rooms', () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it('saves the newest room first and keeps at most five entries', () => {
    for (let index = 1; index <= RECENT_ROOMS_LIMIT + 2; index += 1) {
      rememberRoom(`192.168.1.${index}:8080`, 1000 + index, storage);
    }

    const rooms = loadRecentRooms(storage);
    expect(rooms).toHaveLength(RECENT_ROOMS_LIMIT);
    expect(rooms[0].address).toBe('192.168.1.7:8080');
    expect(rooms.at(-1)?.address).toBe('192.168.1.3:8080');
  });

  it('dedupes by address and keeps the latest timestamp', () => {
    rememberRoom('192.168.1.5:8080', 1000, storage);
    rememberRoom('192.168.1.6:8080', 2000, storage);
    rememberRoom('192.168.1.5:8080', 3000, storage);

    const rooms = loadRecentRooms(storage);
    expect(rooms.map((room) => room.address)).toEqual(['192.168.1.5:8080', '192.168.1.6:8080']);
    expect(rooms[0].savedAt).toBe(3000);
  });

  it('survives corrupt stored json without blocking the flow', () => {
    storage.setItem(RECENT_ROOMS_KEY, '{not json');
    expect(loadRecentRooms(storage)).toEqual([]);
    expect(() => rememberRoom('192.168.1.5:8080', 1, storage)).not.toThrow();
    expect(loadRecentRooms(storage)).toHaveLength(1);
  });

  it('ignores malformed entries inside otherwise valid json', () => {
    storage.setItem(RECENT_ROOMS_KEY, JSON.stringify([{ address: '192.168.1.5:8080', savedAt: 5 }, { savedAt: 6 }, 'junk']));
    expect(loadRecentRooms(storage)).toEqual([{ address: '192.168.1.5:8080', savedAt: 5 }]);
  });

  it('keeps working when storage writes throw (private mode / quota)', () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => rememberRoom('192.168.1.5:8080', 1, broken)).not.toThrow();
    expect(loadRecentRooms(broken)).toEqual([]);
  });

  it('keeps working when storage reads throw', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(loadRecentRooms(broken)).toEqual([]);
  });

  it('clears the list', () => {
    rememberRoom('192.168.1.5:8080', 1, storage);
    expect(clearRecentRooms(storage)).toEqual([]);
    expect(loadRecentRooms(storage)).toEqual([]);
  });
});
