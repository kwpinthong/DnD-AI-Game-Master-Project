import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import './confirm-dialog.css';

/**
 * Asks before something that cannot be undone (GEN-091): a title, what will happen, the danger button and a
 * way out. Focus starts on the way out, Escape takes it.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  cancelLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const textId = useId();
  const cancel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    cancel.current?.querySelector('button')?.focus();
  }, []);
  return (
    <div className="dialog-backdrop">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        className="dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onCancel();
        }}
      >
        <h3 id={titleId} className="dialog__title">
          {title}
        </h3>
        <p id={textId} className="dialog__text">
          {children}
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="dialog__actions" ref={cancel}>
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
