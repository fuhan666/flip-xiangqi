import { audioEngine, audioSettings, useAudioBus, useAudioSettings, type AudioEngine, type AudioSettingsStore } from '../audio';

interface AudioControlsProps {
  /** 容器样式：对局内默认 .panel，设置页可传 room-panel。 */
  className?: string;
  heading?: string;
  engine?: AudioEngine;
  store?: AudioSettingsStore;
}

/**
 * 音量滑杆 + 全局静音开关。
 * 设置只保存在本机浏览器（localStorage），即时生效且不影响对方。
 */
export function AudioControls({
  className = 'panel audio-controls',
  heading = '音效',
  engine = audioEngine,
  store = audioSettings,
}: AudioControlsProps) {
  useAudioBus(engine, store);
  const [settings, controls] = useAudioSettings(store);
  const volumePercent = Math.round(settings.volume * 100);

  return (
    <section className={className} data-testid="audio-controls">
      <h2>{heading}</h2>
      <div className="audio-row">
        <button
          aria-label="静音开关"
          aria-pressed={settings.muted}
          className={settings.muted ? 'panel-action-secondary' : 'panel-action-primary'}
          data-testid="audio-mute-toggle"
          onClick={controls.toggleMuted}
          type="button"
        >
          {settings.muted ? '已静音' : '声音开启'}
        </button>
        <label className="audio-volume-field">
          <span>音量</span>
          <input
            aria-label="音量"
            data-testid="audio-volume-slider"
            max={100}
            min={0}
            onChange={(event) => controls.setVolume(Number(event.target.value) / 100)}
            step={1}
            type="range"
            value={volumePercent}
          />
          <span className="audio-volume-value" data-testid="audio-volume-value">{volumePercent}%</span>
        </label>
      </div>
      <p className="audio-hint">音量与静音只保存在本机浏览器，刷新后保持，不影响对方。</p>
    </section>
  );
}
