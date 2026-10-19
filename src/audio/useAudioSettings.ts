import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AudioEngine } from './engine';
import { audioSettings, type AudioSettings, type AudioSettingsStore } from './settings';

export interface AudioSettingsControls {
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  toggleMuted(): void;
}

/** 订阅全局音效设置：改动立即生效并同步到所有挂载的音量控件。 */
export function useAudioSettings(
  store: AudioSettingsStore = audioSettings,
): [AudioSettings, AudioSettingsControls] {
  const settings = useSyncExternalStore(store.subscribe, store.get, store.get);

  const setVolume = useCallback(
    (volume: number) => {
      store.set({ volume });
    },
    [store],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      store.set({ muted });
    },
    [store],
  );

  const toggleMuted = useCallback(() => {
    store.set({ muted: !store.get().muted });
  }, [store]);

  return [settings, { setVolume, setMuted, toggleMuted }];
}

/**
 * 把本地设置接到播放总线：挂载时按持久化设置初始化，
 * 之后每次设置变化都立即作用于总线（含正在播放的声音），解除静音不补播。
 */
export function useAudioBus(engine: AudioEngine, store: AudioSettingsStore = audioSettings): void {
  useEffect(() => {
    const apply = () => {
      const settings = store.get();
      engine.setVolume(settings.volume);
      engine.setMuted(settings.muted);
    };
    apply();
    return store.subscribe(apply);
  }, [engine, store]);
}
