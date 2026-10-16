interface ToastProps {
  message: string;
}

/**
 * 右上角轻量提示（3 秒自动消失）：
 * 遵循 UX 规范第 6 节，用于非阻断性状态通知（如「已重新连接」）。
 */
export function Toast({ message }: ToastProps) {
  return (
    <div
      aria-live="polite"
      className="room-toast"
      data-testid="reconnected-toast"
      role="status"
    >
      <span aria-hidden="true" className="toast-icon">
        ✓
      </span>
      <span>{message}</span>
    </div>
  );
}
