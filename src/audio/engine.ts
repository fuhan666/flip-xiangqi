/**
 * Web Audio 合成音效引擎。
 *
 * 五类对局音效（翻牌 / 落子 / 吃子 / 将军 / 终局胜利）全部由振荡器、
 * 实时噪声与增益包络合成，仓库不包含任何音频资源文件，也不依赖外部服务。
 *
 * 自动播放策略：AudioContext 只在首个用户手势内创建或 resume；
 * 解锁前到达的音效直接丢弃（不排队补播），因此控制台不会出现未处理的
 * autoplay 告警。Web Audio 不可用时静默降级为无声。
 */

export type SoundName = 'flip' | 'move' | 'capture' | 'check' | 'victory';

export const SOUND_NAMES: readonly SoundName[] = ['flip', 'move', 'capture', 'check', 'victory'];

/** 单步动作最多安排的基础声 + 提示声数量，保证快速连续操作不堆积音效长队列。 */
const MAX_CUES_PER_ACTION = 2;

/** 噪声缓存长度（秒）：足够长，任意偏移起点都能覆盖最长衰减尾。 */
const NOISE_BUFFER_SECONDS = 2;
const NOISE_VARIETY_SECONDS = 1;

export interface AudioEngineOptions {
  /** 自定义 AudioContext 构造（测试注入）；默认使用全局 AudioContext / webkitAudioContext。 */
  contextFactory?: () => AudioContext | null;
  /** 并发声部上限，超出时回收最早的声部。 */
  maxVoices?: number;
  /** 同一步动作内多个音效之间的错峰间隔（秒）。 */
  cueStaggerSeconds?: number;
  /** 总线默认音量（0-1）。 */
  defaultVolume?: number;
}

export interface AudioEngineState {
  unlocked: boolean;
  contextState: string | null;
  activeVoices: number;
}

export interface AudioEngine {
  /** 注册「首个用户手势」监听，返回解绑函数；必须在 effect 中调用而非 render。 */
  attach(): () => void;
  /** 在可信用户手势内解锁音频；重复调用无副作用。 */
  unlock(): void;
  play(sound: SoundName): void;
  playCues(cues: readonly SoundName[]): void;
  /** 取消所有仍在调度中的声部（回到大厅、重开或卸载时使用）。 */
  stopAll(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  getState(): AudioEngineState;
}

interface ScheduledVoice {
  endTime: number;
  cancel: () => void;
}

interface FilterOptions {
  type: BiquadFilterType;
  frequency: number;
  q?: number;
}

interface ToneOptions {
  type: OscillatorType;
  frequency: number;
  endFrequency?: number;
  startAt: number;
  attack: number;
  peak: number;
  decay: number;
  detuneCents?: number;
  filter?: FilterOptions;
}

interface NoiseOptions {
  startAt: number;
  attack: number;
  peak: number;
  decay: number;
  filter: FilterOptions;
  playbackRate?: number;
}

function defaultContextFactory(): AudioContext | null {
  const scope = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * 噪声使用引擎内部的确定性伪随机序列生成并缓存：
 * 既避免反复实时生成开销，也不占用全局 Math.random 流，
 * 保证依赖注入随机数的对局/测试序列保持确定。
 */
function createNoiseRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function createEnvelope(ctx: BaseAudioContext, startAt: number, attack: number, peak: number, decay: number): GainNode {
  const envelopeNode = ctx.createGain();
  const param = envelopeNode.gain;
  param.setValueAtTime(0, startAt);
  param.linearRampToValueAtTime(peak, startAt + attack);
  param.exponentialRampToValueAtTime(0.0001, startAt + attack + decay);
  return envelopeNode;
}

function appendFilter(ctx: BaseAudioContext, source: AudioNode, options: FilterOptions, startAt: number): AudioNode {
  const filterNode = ctx.createBiquadFilter();
  filterNode.type = options.type;
  filterNode.frequency.setValueAtTime(options.frequency, startAt);
  if (options.q !== undefined) {
    filterNode.Q.setValueAtTime(options.q, startAt);
  }
  source.connect(filterNode);
  return filterNode;
}

/** 覆盖 OscillatorNode 与 AudioBufferSourceNode 的 start 签名，便于统一调度起点。 */
type StartableAudioSource = AudioScheduledSourceNode & {
  start(when?: number, offset?: number): void;
};

function finalizeVoice(
  source: StartableAudioSource,
  nodes: AudioNode[],
  startAt: number,
  totalLength: number,
  startOffset?: number,
): ScheduledVoice {
  const endTime = startAt + totalLength;
  source.onended = () => {
    nodes.forEach((node) => {
      try {
        node.disconnect();
      } catch {
        // 节点已断开时忽略。
      }
    });
  };
  source.start(startAt, startOffset);
  source.stop(endTime + 0.02);
  return {
    endTime,
    cancel: () => {
      try {
        source.stop();
      } catch {
        // 节点已结束时忽略。
      }
    },
  };
}

function scheduleTone(ctx: BaseAudioContext, destination: AudioNode, options: ToneOptions): ScheduledVoice {
  const startAt = Math.max(options.startAt, ctx.currentTime);
  const totalLength = options.attack + options.decay;
  const envelopeNode = createEnvelope(ctx, startAt, options.attack, options.peak, options.decay);
  const oscillator = ctx.createOscillator();
  oscillator.type = options.type;
  oscillator.frequency.setValueAtTime(Math.max(1, options.frequency), startAt);
  if (options.endFrequency !== undefined && options.endFrequency !== options.frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, options.endFrequency), startAt + totalLength);
  }
  if (options.detuneCents) {
    oscillator.detune.setValueAtTime(options.detuneCents, startAt);
  }

  const nodes: AudioNode[] = [oscillator, envelopeNode];
  let tail: AudioNode = oscillator;
  if (options.filter) {
    const filterNode = appendFilter(ctx, oscillator, options.filter, startAt);
    nodes.push(filterNode);
    tail = filterNode;
  }
  tail.connect(envelopeNode);
  envelopeNode.connect(destination);

  return finalizeVoice(oscillator, nodes, startAt, totalLength);
}

function scheduleNoise(
  ctx: BaseAudioContext,
  destination: AudioNode,
  getNoise: () => AudioBuffer,
  offset: number,
  options: NoiseOptions,
): ScheduledVoice {
  const startAt = Math.max(options.startAt, ctx.currentTime);
  const totalLength = options.attack + options.decay;
  const envelopeNode = createEnvelope(ctx, startAt, options.attack, options.peak, options.decay);
  const source = ctx.createBufferSource();
  source.buffer = getNoise();
  if (options.playbackRate !== undefined) {
    source.playbackRate.setValueAtTime(options.playbackRate, startAt);
  }

  const filterNode = appendFilter(ctx, source, options.filter, startAt);
  filterNode.connect(envelopeNode);
  envelopeNode.connect(destination);

  return finalizeVoice(source, [source, filterNode, envelopeNode], startAt, totalLength, offset);
}

function buildSound(
  ctx: BaseAudioContext,
  destination: AudioNode,
  getNoise: () => AudioBuffer,
  noiseOffset: number,
  name: SoundName,
  startAt: number,
): ScheduledVoice[] {
  switch (name) {
    // 翻牌：清脆短促的卡片掀动声。
    case 'flip':
      return [
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 780,
          endFrequency: 1180,
          startAt,
          attack: 0.004,
          peak: 0.42,
          decay: 0.06,
          filter: { type: 'lowpass', frequency: 5200 },
        }),
        scheduleNoise(ctx, destination, getNoise, noiseOffset, {
          startAt,
          attack: 0.002,
          peak: 0.22,
          decay: 0.03,
          filter: { type: 'bandpass', frequency: 3000, q: 1.2 },
        }),
      ];

    // 落子：厚重木质敲击感。
    case 'move':
      return [
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 190,
          endFrequency: 96,
          startAt,
          attack: 0.002,
          peak: 0.62,
          decay: 0.16,
        }),
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 330,
          endFrequency: 240,
          startAt,
          attack: 0.002,
          peak: 0.16,
          decay: 0.07,
        }),
        scheduleNoise(ctx, destination, getNoise, noiseOffset, {
          startAt,
          attack: 0.0015,
          peak: 0.38,
          decay: 0.028,
          filter: { type: 'lowpass', frequency: 1500, q: 0.7 },
        }),
      ];

    // 吃子：短促的撞击与破碎感。
    case 'capture':
      return [
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 168,
          endFrequency: 62,
          startAt,
          attack: 0.002,
          peak: 0.55,
          decay: 0.15,
        }),
        scheduleNoise(ctx, destination, getNoise, noiseOffset, {
          startAt,
          attack: 0.002,
          peak: 0.34,
          decay: 0.2,
          filter: { type: 'bandpass', frequency: 1150, q: 0.9 },
        }),
        scheduleNoise(ctx, destination, getNoise, noiseOffset + 0.23, {
          startAt,
          attack: 0.002,
          peak: 0.2,
          decay: 0.12,
          filter: { type: 'bandpass', frequency: 3400, q: 1.4 },
        }),
        scheduleTone(ctx, destination, {
          type: 'square',
          frequency: 430,
          endFrequency: 320,
          startAt,
          attack: 0.002,
          peak: 0.1,
          decay: 0.05,
          filter: { type: 'lowpass', frequency: 1600 },
        }),
        scheduleTone(ctx, destination, {
          type: 'square',
          frequency: 640,
          endFrequency: 520,
          startAt,
          attack: 0.002,
          peak: 0.07,
          decay: 0.045,
          filter: { type: 'lowpass', frequency: 2400 },
        }),
      ];

    // 将军：柔和的两声警示音。
    case 'check':
      return [
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 620,
          startAt,
          attack: 0.012,
          peak: 0.32,
          decay: 0.12,
          filter: { type: 'lowpass', frequency: 3800 },
        }),
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 830,
          startAt: startAt + 0.12,
          attack: 0.012,
          peak: 0.36,
          decay: 0.2,
          filter: { type: 'lowpass', frequency: 3800 },
        }),
        scheduleTone(ctx, destination, {
          type: 'sine',
          frequency: 155,
          startAt,
          attack: 0.02,
          peak: 0.12,
          decay: 0.34,
        }),
      ];

    // 终局胜利：明亮短乐句。
    case 'victory':
      return [
        scheduleTone(ctx, destination, {
          type: 'sine',
          frequency: 98,
          startAt,
          attack: 0.02,
          peak: 0.16,
          decay: 0.8,
        }),
        ...([
          { frequency: 392, start: 0, decay: 0.14, peak: 0.3 },
          { frequency: 523.25, start: 0.13, decay: 0.14, peak: 0.32 },
          { frequency: 659.25, start: 0.26, decay: 0.14, peak: 0.34 },
          { frequency: 783.99, start: 0.39, decay: 0.55, peak: 0.38 },
        ].map((note) =>
          scheduleTone(ctx, destination, {
            type: 'triangle',
            frequency: note.frequency,
            startAt: startAt + note.start,
            attack: 0.012,
            peak: note.peak,
            decay: note.decay,
            filter: { type: 'lowpass', frequency: 5200 },
          }),
        )),
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 523.25,
          startAt: startAt + 0.39,
          attack: 0.02,
          peak: 0.12,
          decay: 0.7,
        }),
        scheduleTone(ctx, destination, {
          type: 'triangle',
          frequency: 659.25,
          startAt: startAt + 0.39,
          attack: 0.02,
          peak: 0.1,
          decay: 0.7,
        }),
      ];

    default:
      return [];
  }
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

class WebAudioEngine implements AudioEngine {
  private readonly options: AudioEngineOptions;
  private readonly maxVoices: number;
  private readonly cueStaggerSeconds: number;
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly noiseRandom = createNoiseRandom(0x5f3759df);
  private voices: ScheduledVoice[] = [];
  private unlocked = false;
  private volume: number;
  private muted = false;

  constructor(options: AudioEngineOptions = {}) {
    this.options = options;
    this.maxVoices = Math.max(1, options.maxVoices ?? 32);
    this.cueStaggerSeconds = Math.max(0, options.cueStaggerSeconds ?? 0.09);
    this.volume = clampVolume(options.defaultVolume ?? 0.6);
  }

  attach(): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return () => undefined;
    }

    const handleGesture = () => {
      this.unlock();
    };
    const events = ['pointerdown', 'touchend', 'mousedown', 'keydown'] as const;
    events.forEach((eventName) => window.addEventListener(eventName, handleGesture, true));

    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, handleGesture, true));
    };
  }

  unlock(): void {
    this.unlocked = true;
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') {
      try {
        void ctx.resume().catch(() => undefined);
      } catch {
        // resume 不可用时保持现状，下一次手势会重试。
      }
    }
  }

  play(sound: SoundName): void {
    this.playCues([sound]);
  }

  playCues(cues: readonly SoundName[]): void {
    if (!this.unlocked || this.muted || this.volume <= 0) {
      return;
    }

    const ctx = this.ensureContext();
    const destination = this.masterGain;
    if (!ctx || !destination) {
      return;
    }

    const startAt = ctx.currentTime + 0.005;
    let offset = 0;
    for (const cue of cues.slice(0, MAX_CUES_PER_ACTION)) {
      this.scheduleCue(ctx, destination, cue, startAt + offset);
      offset += this.cueStaggerSeconds;
    }
  }

  stopAll(): void {
    this.voices.forEach((voice) => voice.cancel());
    this.voices = [];
  }

  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
    this.applyMasterGain();
  }

  setMuted(muted: boolean): void {
    this.muted = Boolean(muted);
    this.applyMasterGain();
  }

  getState(): AudioEngineState {
    return {
      unlocked: this.unlocked,
      contextState: this.context ? this.context.state : null,
      activeVoices: this.voices.length,
    };
  }

  private scheduleCue(
    ctx: BaseAudioContext,
    destination: AudioNode,
    name: SoundName,
    startAt: number,
  ): void {
    this.pruneVoices(ctx.currentTime);
    const noiseOffset = this.noiseRandom() * NOISE_VARIETY_SECONDS;
    const voices = buildSound(ctx, destination, () => this.getNoiseBuffer(ctx), noiseOffset, name, startAt);
    for (const voice of voices) {
      if (this.voices.length >= this.maxVoices) {
        const oldest = this.voices.shift();
        oldest?.cancel();
      }
      this.voices.push(voice);
    }
  }

  private pruneVoices(now: number): void {
    if (this.voices.length === 0) {
      return;
    }
    this.voices = this.voices.filter((voice) => voice.endTime > now);
  }

  private getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
    if (this.noiseBuffer) {
      return this.noiseBuffer;
    }
    const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BUFFER_SECONDS));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      channel[index] = this.noiseRandom() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      return this.context;
    }
    if (!this.unlocked) {
      return null;
    }

    const factory = this.options.contextFactory ?? defaultContextFactory;
    let ctx: AudioContext | null = null;
    try {
      ctx = factory();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      return null;
    }

    const masterGain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 24;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    masterGain.connect(limiter);
    limiter.connect(ctx.destination);

    this.context = ctx;
    this.masterGain = masterGain;
    this.applyMasterGain();
    return ctx;
  }

  private applyMasterGain(): void {
    const gainNode = this.masterGain;
    const ctx = this.context;
    if (!gainNode || !ctx) {
      return;
    }
    const target = this.muted ? 0 : this.volume;
    try {
      // 极短时间常数：听感上即时生效，同时避免包络突变产生爆音。
      gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.01);
    } catch {
      gainNode.gain.value = target;
    }
  }
}

export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngine {
  return new WebAudioEngine(options);
}
