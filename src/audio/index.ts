/**
 * 音频层入口：原生合成音效引擎、音效映射与本地设置。
 * 全部纯合成实现，不引入任何音频资源文件或外部服务。
 */

export {
  createAudioEngine,
  SOUND_NAMES,
  type AudioEngine,
  type AudioEngineOptions,
  type AudioEngineState,
  type SoundName,
} from './engine';
export {
  baseSoundForEntry,
  hasCaptureConsequence,
  hasCheckConsequence,
  hasEndgameConsequence,
  soundCuesForHistoryEntry,
  soundCuesForMatchEnd,
  type ActionSoundOptions,
} from './game-sounds';
export {
  audioSettings,
  createAudioSettingsStore,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_AUDIO_VOLUME,
  AUDIO_SETTINGS_KEY,
  loadAudioSettings,
  parseAudioSettings,
  saveAudioSettings,
  type AudioSettings,
  type AudioSettingsStore,
} from './settings';
export { useAudioBus, useAudioSettings, type AudioSettingsControls } from './useAudioSettings';

import { createAudioEngine, type AudioEngine } from './engine';

/** 全局共享音效引擎：本地模式与联机模式共用同一条播放总线。 */
export const audioEngine: AudioEngine = createAudioEngine();
