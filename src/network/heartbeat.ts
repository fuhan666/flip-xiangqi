/**
 * 心跳保活与延迟计算辅助模块：
 * - 集中管理心跳间隔、超时判定与重连退避常量；
 * - 提供纯函数计算延迟等级（绿 ≤80ms / 黄 80–200ms / 红 ≥200ms 或断线）。
 */

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 2_000;
export const DEFAULT_RECONNECT_DELAYS = [500, 1_000, 2_000, 4_000] as const;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 4_000;
export const DEFAULT_RECONNECT_BUDGET_MS = 20_000;

export type LatencyQuality = 'good' | 'medium' | 'bad' | 'disconnected' | 'measuring';
export type LampColor = 'green' | 'yellow' | 'red';

export function getLatencyQuality(rtt: number | null, connected: boolean): LatencyQuality {
  if (!connected) {
    return 'disconnected';
  }
  if (rtt === null) {
    return 'measuring';
  }
  if (rtt <= 80) {
    return 'good';
  }
  if (rtt < 200) {
    return 'medium';
  }
  return 'bad';
}

export function getLampColor(quality: LatencyQuality): LampColor {
  switch (quality) {
    case 'good':
      return 'green';
    case 'medium':
    case 'measuring':
      return 'yellow';
    case 'bad':
    case 'disconnected':
      return 'red';
  }
}

export interface LatencyDescription {
  quality: LatencyQuality;
  lamp: LampColor;
  label: string;
  rttText: string;
  fullText: string;
}

export function describeLatency(rtt: number | null, connected: boolean): LatencyDescription {
  const quality = getLatencyQuality(rtt, connected);
  const lamp = getLampColor(quality);

  switch (quality) {
    case 'disconnected':
      return {
        quality,
        lamp,
        label: '断线',
        rttText: '—',
        fullText: '断线',
      };
    case 'measuring':
      return {
        quality,
        lamp,
        label: '测量中',
        rttText: '—',
        fullText: '测量中…',
      };
    case 'good':
      return {
        quality,
        lamp,
        label: '良好',
        rttText: `${rtt}ms`,
        fullText: `良好 ${rtt}ms`,
      };
    case 'medium':
      return {
        quality,
        lamp,
        label: '较高延迟',
        rttText: `${rtt}ms`,
        fullText: `较高延迟 ${rtt}ms`,
      };
    case 'bad':
      return {
        quality,
        lamp,
        label: '高延迟',
        rttText: `${rtt}ms`,
        fullText: `高延迟 ${rtt}ms`,
      };
  }
}

export function computeBackoffDelay(attempt: number, delays: readonly number[] = DEFAULT_RECONNECT_DELAYS): number {
  if (delays.length === 0) {
    return DEFAULT_RECONNECT_MAX_DELAY_MS;
  }
  const index = Math.max(0, Math.min(attempt, delays.length - 1));
  return delays[index];
}
