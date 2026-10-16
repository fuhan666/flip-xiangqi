interface ConnectionBannerProps {
  onReconnect: () => void;
  message?: string;
}

/**
 * 断线重连横幅：
 * - 顶部整行警示条；
 * - 包含文案与「重新连接」快捷按钮（触控区域 ≥44px）。
 */
export function ConnectionBanner({
  onReconnect,
  message = '与房间的连接已断开，正在重连…',
}: ConnectionBannerProps) {
  return (
    <div
      aria-live="assertive"
      className="connection-banner"
      data-testid="connection-banner"
      role="alert"
    >
      <div className="connection-banner-text">
        <span aria-hidden="true" className="connection-banner-icon">
          ⚠️
        </span>
        <span>{message}</span>
      </div>
      <button
        className="connection-banner-action"
        data-testid="reconnect-button"
        onClick={onReconnect}
        type="button"
      >
        重新连接
      </button>
    </div>
  );
}
