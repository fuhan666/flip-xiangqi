import type { ConnectionStatus as ClientConnectionStatus } from '../../network/client';
import { describeLatency } from '../../network/heartbeat';

interface ConnectionStatusProps {
  status: ClientConnectionStatus;
  rtt: number | null;
}

/**
 * 房间连接状态指示灯与延迟展示：
 * - 绿=≤80ms（良好）
 * - 黄=80–200ms（较高延迟）或测量中
 * - 红=断线或≥200ms（高延迟）
 */
export function ConnectionStatus({ status, rtt }: ConnectionStatusProps) {
  const connected = status === 'connected';
  const desc = describeLatency(rtt, connected);

  return (
    <div
      aria-label={`网络状态：${desc.fullText}`}
      aria-live="polite"
      className="connection-status"
      data-testid="connection-status"
    >
      <span
        aria-hidden="true"
        className={`connection-lamp connection-lamp-${desc.lamp}`}
        data-testid="connection-lamp"
      />
      <span className="connection-label">{desc.label}</span>
      <span className="connection-rtt" data-testid="connection-rtt">
        {desc.rttText}
      </span>
    </div>
  );
}
