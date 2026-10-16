import { describe, expect, it } from 'vitest';
import {
  computeBackoffDelay,
  describeLatency,
  getLampColor,
  getLatencyQuality,
  DEFAULT_RECONNECT_DELAYS,
} from '../heartbeat';

describe('heartbeat and latency calculations', () => {
  it('correctly classifies RTT boundaries (<=80 green, 80-200 yellow, >=200 red)', () => {
    // 良好 <=80ms
    expect(getLatencyQuality(0, true)).toBe('good');
    expect(getLatencyQuality(40, true)).toBe('good');
    expect(getLatencyQuality(80, true)).toBe('good');
    expect(getLampColor('good')).toBe('green');

    // 较高延迟 80-200ms
    expect(getLatencyQuality(81, true)).toBe('medium');
    expect(getLatencyQuality(150, true)).toBe('medium');
    expect(getLatencyQuality(199, true)).toBe('medium');
    expect(getLampColor('medium')).toBe('yellow');

    // 高延迟 >=200ms
    expect(getLatencyQuality(200, true)).toBe('bad');
    expect(getLatencyQuality(350, true)).toBe('bad');
    expect(getLampColor('bad')).toBe('red');

    // 未测得 RTT (null)
    expect(getLatencyQuality(null, true)).toBe('measuring');
    expect(getLampColor('measuring')).toBe('yellow');

    // 断线
    expect(getLatencyQuality(50, false)).toBe('disconnected');
    expect(getLatencyQuality(null, false)).toBe('disconnected');
    expect(getLampColor('disconnected')).toBe('red');
  });

  it('describes latency with accurate user-facing labels and formatted ms', () => {
    const good = describeLatency(42, true);
    expect(good.lamp).toBe('green');
    expect(good.label).toBe('良好');
    expect(good.rttText).toBe('42ms');
    expect(good.fullText).toBe('良好 42ms');

    const medium = describeLatency(120, true);
    expect(medium.lamp).toBe('yellow');
    expect(medium.label).toBe('较高延迟');
    expect(medium.rttText).toBe('120ms');

    const bad = describeLatency(250, true);
    expect(bad.lamp).toBe('red');
    expect(bad.label).toBe('高延迟');
    expect(bad.rttText).toBe('250ms');

    const measuring = describeLatency(null, true);
    expect(measuring.lamp).toBe('yellow');
    expect(measuring.label).toBe('测量中');
    expect(measuring.rttText).toBe('—');

    const disconnected = describeLatency(null, false);
    expect(disconnected.lamp).toBe('red');
    expect(disconnected.label).toBe('断线');
    expect(disconnected.rttText).toBe('—');
  });

  it('computes exponential backoff with cap at 4000ms', () => {
    expect(DEFAULT_RECONNECT_DELAYS).toEqual([500, 1000, 2000, 4000]);
    expect(computeBackoffDelay(0)).toBe(500);
    expect(computeBackoffDelay(1)).toBe(1000);
    expect(computeBackoffDelay(2)).toBe(2000);
    expect(computeBackoffDelay(3)).toBe(4000);
    expect(computeBackoffDelay(4)).toBe(4000);
    expect(computeBackoffDelay(10)).toBe(4000);

    const custom = [100, 200, 400];
    expect(computeBackoffDelay(0, custom)).toBe(100);
    expect(computeBackoffDelay(1, custom)).toBe(200);
    expect(computeBackoffDelay(2, custom)).toBe(400);
    expect(computeBackoffDelay(5, custom)).toBe(400);
  });
});
