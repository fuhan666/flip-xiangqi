import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_SETTINGS_KEY,
  DEFAULT_AUDIO_SETTINGS,
  createAudioSettingsStore,
  loadAudioSettings,
  parseAudioSettings,
  saveAudioSettings,
} from '../settings';
import type { StorageLike } from '../../network/recent-rooms';

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

describe('audio settings persistence', () => {
  it('falls back to defaults on empty, malformed or out-of-range values', () => {
    expect(parseAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings('')).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings('{not json')).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings('[]')).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings(JSON.stringify({ volume: 12, muted: 'yes' }))).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings(JSON.stringify({ volume: -1 }))).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings(JSON.stringify({ volume: Number.NaN }))).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('keeps valid fields and ignores unknown ones', () => {
    expect(parseAudioSettings(JSON.stringify({ volume: 0.25, muted: true, extra: 'x' }))).toEqual({
      volume: 0.25,
      muted: true,
    });
  });

  it('round-trips through storage and survives a reload', () => {
    const storage = memoryStorage();

    saveAudioSettings({ volume: 0.42, muted: true }, storage);
    expect(loadAudioSettings(storage)).toEqual({ volume: 0.42, muted: true });

    // 模拟刷新：重新从同一存储读取。
    const reloaded = createAudioSettingsStore(storage);
    expect(reloaded.get()).toEqual({ volume: 0.42, muted: true });
  });

  it('keeps the volume untouched when muting and unmuting', () => {
    const storage = memoryStorage();
    const store = createAudioSettingsStore(storage);

    store.set({ volume: 0.8 });
    store.set({ muted: true });
    expect(store.get()).toEqual({ volume: 0.8, muted: true });

    store.set({ muted: false });
    expect(store.get()).toEqual({ volume: 0.8, muted: false });
  });

  it('writes to storage on every change', () => {
    const storage = memoryStorage();
    const store = createAudioSettingsStore(storage);

    store.set({ volume: 0.15 });
    expect(storage.getItem(AUDIO_SETTINGS_KEY)).toBe(JSON.stringify({ volume: 0.15, muted: false }));

    store.set({ muted: true });
    expect(storage.getItem(AUDIO_SETTINGS_KEY)).toBe(JSON.stringify({ volume: 0.15, muted: true }));
  });

  it('notifies subscribers once per effective change', () => {
    const store = createAudioSettingsStore(memoryStorage());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set({ volume: 0.3 });
    store.set({ volume: 0.3 });
    store.set({ muted: true });

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.set({ muted: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores invalid patches and keeps working when storage throws', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };

    const store = createAudioSettingsStore(broken);
    expect(store.get()).toEqual(DEFAULT_AUDIO_SETTINGS);

    expect(() => store.set({ volume: 0.5, muted: true })).not.toThrow();
    expect(store.get()).toEqual({ volume: 0.5, muted: true });

    // 非法补丁被忽略，保留当前有效值。
    store.set({ volume: 99, muted: 'no' as unknown as boolean });
    expect(store.get()).toEqual({ volume: 0.5, muted: true });

    store.set({ volume: Number.NaN });
    expect(store.get()).toEqual({ volume: 0.5, muted: true });
  });
});
