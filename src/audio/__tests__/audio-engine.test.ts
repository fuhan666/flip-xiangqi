import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioEngine, type AudioEngine, type SoundName } from '../engine';
import { FakeAudioContext, noiseBufferFilled } from '../../test/fake-audio-context';

function unlockWithGesture(engine: AudioEngine): void {
  engine.unlock();
}

function counts(): { oscillators: number; buffers: number } {
  const ctx = FakeAudioContext.current();
  if (!ctx) {
    return { oscillators: 0, buffers: 0 };
  }
  return {
    oscillators: ctx.scheduled.filter((record) => record.kind === 'oscillator').length,
    buffers: ctx.scheduled.filter((record) => record.kind === 'bufferSource').length,
  };
}

beforeEach(() => {
  FakeAudioContext.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('audio engine: autoplay policy', () => {
  it('drops sounds and never creates a context before the first user gesture', () => {
    const engine = createAudioEngine();

    engine.play('flip');
    engine.play('victory');

    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(engine.getState()).toMatchObject({ unlocked: false, contextState: null, activeVoices: 0 });
  });

  it('creates and resumes the context inside the first gesture, and does not replay dropped sounds', () => {
    const engine = createAudioEngine();
    engine.play('flip');

    const detach = engine.attach();
    window.dispatchEvent(new Event('pointerdown'));

    const ctx = FakeAudioContext.current();
    expect(engine.getState().unlocked).toBe(true);
    expect(ctx?.state).toBe('running');
    expect(ctx?.scheduled).toHaveLength(0);

    engine.play('flip');
    expect(ctx!.scheduled.length).toBeGreaterThan(0);
    detach();
  });

  it('detaches gesture listeners on cleanup so later gestures no longer unlock', () => {
    const engine = createAudioEngine();
    const detach = engine.attach();
    detach();

    window.dispatchEvent(new Event('pointerdown'));

    expect(engine.getState().unlocked).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('keeps retrying resume after a rejected resume', async () => {
    const engine = createAudioEngine();
    engine.unlock();
    const ctx = FakeAudioContext.current()!;
    ctx.setResumeBehaviour('reject');
    ctx.state = 'suspended';

    engine.unlock();
    await Promise.resolve();
    expect(ctx.resumeCalls).toBe(2);
    expect(ctx.state).toBe('suspended');

    ctx.setResumeBehaviour('resolve');
    engine.unlock();
    await Promise.resolve();
    expect(ctx.state).toBe('running');
  });

  it('degrades silently when Web Audio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    const engine = createAudioEngine({ contextFactory: () => null });

    expect(() => {
      engine.unlock();
      engine.play('capture');
    }).not.toThrow();
    expect(engine.getState().contextState).toBeNull();
  });

  it('degrades silently when the context factory throws', () => {
    const engine = createAudioEngine({
      contextFactory: () => {
        throw new Error('blocked by policy');
      },
    });

    expect(() => {
      engine.unlock();
      engine.play('move');
    }).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

describe('audio engine: synthesis graph', () => {
  const expectations: Array<{ sound: SoundName; oscillators: number; buffers: number; maxSeconds: number }> = [
    { sound: 'flip', oscillators: 1, buffers: 1, maxSeconds: 0.15 },
    { sound: 'move', oscillators: 2, buffers: 1, maxSeconds: 0.3 },
    { sound: 'capture', oscillators: 3, buffers: 2, maxSeconds: 0.45 },
    { sound: 'check', oscillators: 3, buffers: 0, maxSeconds: 0.8 },
    { sound: 'victory', oscillators: 7, buffers: 0, maxSeconds: 1.6 },
  ];

  for (const expectation of expectations) {
    it(`synthesises ${expectation.sound} from oscillators and cached noise only`, () => {
      const engine = createAudioEngine();
      unlockWithGesture(engine);

      engine.play(expectation.sound);

      const ctx = FakeAudioContext.current()!;
      expect(counts()).toEqual({
        oscillators: expectation.oscillators,
        buffers: expectation.buffers,
      });

      const longest = Math.max(...ctx.scheduled.map((record) => (record.stopTime ?? 0) - record.startTime));
      expect(longest).toBeGreaterThan(0);
      expect(longest).toBeLessThanOrEqual(expectation.maxSeconds);

      // 纯合成：不加载任何音频资源，噪声只生成一次并缓存复用。
      expect(ctx.buffers).toHaveLength(expectation.buffers > 0 ? 1 : 0);
      if (expectation.buffers > 0) {
        expect(noiseBufferFilled(ctx.buffers[0])).toBe(true);
      }
    });
  }

  it('reuses a single cached noise buffer across repeated sounds', () => {
    const engine = createAudioEngine();
    unlockWithGesture(engine);

    engine.play('flip');
    engine.play('capture');

    const ctx = FakeAudioContext.current()!;
    expect(ctx.buffers).toHaveLength(1);
    expect(counts()).toEqual({ oscillators: 4, buffers: 3 });
  });

  it('gives the flip a rising pitch and the move a falling body pitch', () => {
    const engine = createAudioEngine();
    unlockWithGesture(engine);

    engine.play('flip');
    const flipTone = FakeAudioContext.current()!.scheduled[0];
    expect(flipTone.kind).toBe('oscillator');
    expect(flipTone.endFrequency!).toBeGreaterThan(flipTone.startFrequency!);

    engine.play('move');
    const moveTone = FakeAudioContext.current()!.scheduled.filter((record) => record.kind === 'oscillator').pop()!;
    expect(moveTone.endFrequency!).toBeLessThan(moveTone.startFrequency!);
  });
});

describe('audio engine: volume, mute and scheduling limits', () => {
  it('drops sounds at zero volume and while muted, and restores playback afterwards', () => {
    const engine = createAudioEngine();
    unlockWithGesture(engine);

    engine.setVolume(0);
    engine.play('flip');
    expect(counts()).toEqual({ oscillators: 0, buffers: 0 });

    engine.setVolume(0.6);
    engine.setMuted(true);
    engine.play('flip');
    expect(counts()).toEqual({ oscillators: 0, buffers: 0 });

    engine.setMuted(false);
    engine.play('flip');
    expect(counts().oscillators).toBe(1);
  });

  it('applies volume and mute to the master bus immediately', () => {
    const engine = createAudioEngine();
    unlockWithGesture(engine);
    const ctx = FakeAudioContext.current()!;
    const master = ctx.gains[0];

    engine.setVolume(0.35);
    expect(master.gain.events.at(-1)).toEqual({
      method: 'setTargetAtTime',
      args: [0.35, 0, 0.01],
    });

    engine.setMuted(true);
    expect(master.gain.events.at(-1)).toEqual({
      method: 'setTargetAtTime',
      args: [0, 0, 0.01],
    });

    engine.setMuted(false);
    expect(master.gain.events.at(-1)!.args[0]).toBe(0.35);
  });

  it('clamps volume to the 0-1 range', () => {
    const engine = createAudioEngine();
    unlockWithGesture(engine);
    const master = FakeAudioContext.current()!.gains[0];

    engine.setVolume(12);
    expect(master.gain.events.at(-1)!.args[0]).toBe(1);
    engine.setVolume(-4);
    expect(master.gain.events.at(-1)!.args[0]).toBe(0);
    engine.setVolume(Number.NaN);
    expect(master.gain.events.at(-1)!.args[0]).toBe(0);
  });

  it('caps concurrent voices by recycling the oldest ones', () => {
    const engine = createAudioEngine({ maxVoices: 3 });
    unlockWithGesture(engine);

    engine.play('capture');

    const ctx = FakeAudioContext.current()!;
    expect(ctx.scheduled).toHaveLength(5);
    expect(ctx.scheduled.filter((record) => record.stopTime === 0)).toHaveLength(2);
  });

  it('schedules at most one base sound plus one cue per action', () => {
    const engine = createAudioEngine();
    unlockWithGesture(engine);

    engine.playCues(['flip', 'move', 'check', 'victory']);

    const ctx = FakeAudioContext.current()!;
    // 只安排 flip + move 两组（各自单独起点），多余的提示声被丢弃，
    // 避免快速连击堆积音效长队列。
    const startTimes = new Set(ctx.scheduled.map((record) => record.startTime));
    expect(startTimes.size).toBe(2);
  });

  it('staggered cues start later than the base sound', () => {
    const engine = createAudioEngine({ cueStaggerSeconds: 0.09 });
    unlockWithGesture(engine);

    engine.playCues(['move', 'flip']);

    const ctx = FakeAudioContext.current()!;
    const startTimes = [...new Set(ctx.scheduled.map((record) => record.startTime))].sort((a, b) => a - b);
    expect(startTimes).toHaveLength(2);
    expect(startTimes[1] - startTimes[0]).toBeCloseTo(0.09, 5);
  });

  it('stopAll cancels every scheduled voice', () => {
    const engine = createAudioEngine();
    unlockWithGesture(engine);

    engine.play('victory');
    expect(engine.getState().activeVoices).toBe(7);

    engine.stopAll();

    const ctx = FakeAudioContext.current()!;
    expect(engine.getState().activeVoices).toBe(0);
    expect(ctx.scheduled.every((record) => record.stopped)).toBe(true);
    expect(ctx.scheduled.filter((record) => record.stopTime === 0)).toHaveLength(7);
  });
});
