import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 阻断性确认弹层：Esc 关闭、焦点默认落在取消按钮上。 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = '取消',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div className="confirm-backdrop" role="presentation" onClick={onCancel}>
      <div
        aria-labelledby="confirm-dialog-title"
        aria-modal="true"
        className="confirm-dialog"
        data-testid="confirm-dialog"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-title" id="confirm-dialog-title">
          {title}
        </h2>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="confirm-cancel" data-testid="confirm-no" onClick={onCancel} ref={cancelRef} type="button">
            {cancelLabel}
          </button>
          <button className="confirm-accept" data-testid="confirm-yes" onClick={onConfirm} type="button">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
