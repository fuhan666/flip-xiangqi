/**
 * 测试用 Web Audio 假实现：只记录调度行为（节点创建、起点、停止、参数变化），
 * 用于在 jsdom 中验证合成音效的调度约束，而不真正发声。
 */

export class FakeAudioParam {
  value = 0;
  readonly events: Array<{ method: string; args: number[] }> = [];

  setValueAtTime(value: number, startTime: number): FakeAudioParam {
    this.value = value;
    this.events.push({ method: 'setValueAtTime', args: [value, startTime] });
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): FakeAudioParam {
    this.value = value;
    this.events.push({ method: 'linearRampToValueAtTime', args: [value, endTime] });
    return this;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): FakeAudioParam {
    this.value = value;
    this.events.push({ method: 'exponentialRampToValueAtTime', args: [value, endTime] });
    return this;
  }

  setTargetAtTime(value: number, startTime: number, timeConstant: number): FakeAudioParam {
    this.value = value;
    this.events.push({ method: 'setTargetAtTime', args: [value, startTime, timeConstant] });
    return this;
  }

  cancelScheduledValues(startTime: number): FakeAudioParam {
    this.events.push({ method: 'cancelScheduledValues', args: [startTime] });
    return this;
  }
}

export class FakeAudioNode {
  readonly connections: unknown[] = [];
  readonly context: FakeAudioContext;

  constructor(context: FakeAudioContext) {
    this.context = context;
  }

  connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam();
  readonly knee = new FakeAudioParam();
  readonly ratio = new FakeAudioParam();
  readonly attack = new FakeAudioParam();
  readonly release = new FakeAudioParam();
}

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(index: number): Float32Array {
    return this.channels[index];
  }
}

export interface ScheduledRecord {
  kind: 'oscillator' | 'bufferSource';
  waveform: string | null;
  startFrequency: number | null;
  endFrequency: number | null;
  startTime: number;
  stopTime: number | null;
  stopped: boolean;
  startOffset: number | null;
  disconnected: boolean;
}

class FakeScheduledSource extends FakeAudioNode {
  onended: (() => void) | null = null;
  readonly record: ScheduledRecord;

  constructor(context: FakeAudioContext, record: ScheduledRecord) {
    super(context);
    this.record = record;
    context.scheduled.push(record);
  }

  start(startTime = 0, startOffset?: number): void {
    this.record.startTime = startTime;
    this.record.startOffset = startOffset ?? null;
  }

  stop(stopTime = 0): void {
    this.record.stopTime = stopTime;
    this.record.stopped = true;
  }

  finish(): void {
    if (this.onended) {
      this.onended();
    }
    this.record.disconnected = true;
  }
}

export class FakeOscillatorNode extends FakeScheduledSource {
  type = 'sine';
  readonly frequency = new FakeAudioParam();
  readonly detune = new FakeAudioParam();

  constructor(context: FakeAudioContext) {
    super(context, {
      kind: 'oscillator',
      waveform: null,
      startFrequency: null,
      endFrequency: null,
      startTime: 0,
      stopTime: null,
      stopped: false,
      startOffset: null,
      disconnected: false,
    });
  }

  override start(startTime = 0, startOffset?: number): void {
    super.start(startTime, startOffset);
    this.record.waveform = this.type;
    this.record.startFrequency = this.frequency.events[0]?.args[0] ?? this.frequency.value;
    const ramps = this.frequency.events.filter((event) => event.method === 'exponentialRampToValueAtTime');
    this.record.endFrequency = ramps.length > 0 ? ramps[ramps.length - 1].args[0] : this.record.startFrequency;
  }
}

export class FakeAudioBufferSourceNode extends FakeScheduledSource {
  buffer: FakeAudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam();

  constructor(context: FakeAudioContext) {
    super(context, {
      kind: 'bufferSource',
      waveform: null,
      startFrequency: null,
      endFrequency: null,
      startTime: 0,
      stopTime: null,
      stopped: false,
      startOffset: null,
      disconnected: false,
    });
  }
}

export class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];

  readonly currentTime = 0;
  readonly sampleRate = 48000;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination: FakeAudioNode;
  readonly created: string[] = [];
  readonly scheduled: ScheduledRecord[] = [];
  readonly buffers: FakeAudioBuffer[] = [];
  readonly gains: FakeGainNode[] = [];
  resumeCalls = 0;
  private resumeBehaviour: 'resolve' | 'reject' = 'resolve';

  constructor() {
    this.destination = new FakeAudioNode(this);
    FakeAudioContext.instances.push(this);
    this.created.push('context');
  }

  static reset(): void {
    FakeAudioContext.instances.length = 0;
  }

  static current(): FakeAudioContext | null {
    return FakeAudioContext.instances.length > 0
      ? FakeAudioContext.instances[FakeAudioContext.instances.length - 1]
      : null;
  }

  setResumeBehaviour(behaviour: 'resolve' | 'reject'): void {
    this.resumeBehaviour = behaviour;
  }

  createGain(): FakeGainNode {
    this.created.push('gain');
    const node = new FakeGainNode(this);
    this.gains.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    this.created.push('filter');
    return new FakeBiquadFilterNode(this);
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    this.created.push('compressor');
    return new FakeDynamicsCompressorNode(this);
  }

  createOscillator(): FakeOscillatorNode {
    this.created.push('oscillator');
    return new FakeOscillatorNode(this);
  }

  createBufferSource(): FakeAudioBufferSourceNode {
    this.created.push('bufferSource');
    return new FakeAudioBufferSourceNode(this);
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    this.created.push('buffer');
    const buffer = new FakeAudioBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeBehaviour === 'reject') {
      this.state = 'suspended';
      return Promise.reject(new Error('resume rejected'));
    }
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** 假的噪声缓存起点范围：用于断言噪声源确实被复用同一缓存。 */
export function noiseBufferFilled(buffer: FakeAudioBuffer): boolean {
  const channel = buffer.getChannelData(0);
  let nonZero = 0;
  for (let index = 0; index < channel.length; index += 1) {
    if (channel[index] !== 0) {
      nonZero += 1;
    }
  }
  return nonZero > 0;
}
