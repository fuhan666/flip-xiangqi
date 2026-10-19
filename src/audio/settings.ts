/**
 * 音效设置（音量 / 全局静音）本地持久化。
 *
 * 只影响本浏览器的播放总线，不进入房间协议，也不影响对局规则；
 * 存储不可用或数据损坏时静默退回内存中的默认值，绝不阻断对局流程。
 */

import { defaultStorage, type StorageLike } from '../network/recent-rooms';

export const AUDIO_SETTINGS_KEY = 'flip-xiangqi.audio';
export const DEFAULT_AUDIO_VOLUME = 0.6;

export interface AudioSettings {
  /** 播放总线音量（0-1）。 */
  volume: number;
  /** 全局静音开关；静音保留原音量，解除后立即恢复。 */
  muted: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  volume: DEFAULT_AUDIO_VOLUME,
  muted: false,
};

function normalizeVolume(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 1) {
    return null;
  }
  return value;
}

export function parseAudioSettings(raw: string | null): AudioSettings {
  if (!raw) {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }

  const record = parsed as { volume?: unknown; muted?: unknown };
  const volume = normalizeVolume(record.volume);
  return {
    volume: volume ?? DEFAULT_AUDIO_VOLUME,
    muted: typeof record.muted === 'boolean' ? record.muted : false,
  };
}

export function loadAudioSettings(storage: StorageLike = defaultStorage()): AudioSettings {
  try {
    return parseAudioSettings(storage.getItem(AUDIO_SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export function saveAudioSettings(settings: AudioSettings, storage: StorageLike = defaultStorage()): void {
  try {
    storage.setItem(
      AUDIO_SETTINGS_KEY,
      JSON.stringify({ volume: settings.volume, muted: settings.muted }),
    );
  } catch {
    // 存储不可用时仅本次生效。
  }
}

export interface AudioSettingsStore {
  get(): AudioSettings;
  set(patch: Partial<AudioSettings>): AudioSettings;
  subscribe(listener: () => void): () => void;
}

export function createAudioSettingsStore(storage: StorageLike = defaultStorage()): AudioSettingsStore {
  let current: AudioSettings = loadAudioSettings(storage);
  const listeners = new Set<() => void>();

  return {
    get: () => current,
    set: (patch) => {
      const next: AudioSettings = {
        volume: normalizeVolume(patch.volume) ?? current.volume,
        muted: typeof patch.muted === 'boolean' ? patch.muted : current.muted,
      };
      if (next.volume === current.volume && next.muted === current.muted) {
        return current;
      }
      current = next;
      saveAudioSettings(next, storage);
      listeners.forEach((listener) => listener());
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 全局共享设置：本地模式与联机模式共用同一条播放总线。 */
export const audioSettings: AudioSettingsStore = createAudioSettingsStore();
