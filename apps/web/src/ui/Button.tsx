import { useId, type ButtonHTMLAttributes } from 'react';
import { uiText } from './strings.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary = the one main action of a screen, secondary = everything else, danger = cannot be undone. */
  variant?: ButtonVariant;
  /** A request is running: the button cannot be pressed, is aria-busy and says so. */
  loading?: boolean;
  loadingText?: string;
  /** Why a disabled button is disabled, shown under it (a disabled button tells nothing by itself). */
  disabledReason?: string;
};

export function Button({
  variant = 'secondary',
  loading = false,
  loadingText = uiText.loading,
  disabledReason,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const reasonId = useId();
  const showReason = Boolean(disabled && !loading && disabledReason);
  const button = (
    <button
      {...rest}
      type={type}
      className={['btn', `btn--${variant}`, className].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-describedby={showReason ? reasonId : rest['aria-describedby']}
    >
      {loading ? (
        <>
          <span className="btn__spinner" aria-hidden="true" />
          {loadingText}
        </>
      ) : (
        children
      )}
    </button>
  );
  if (!showReason) return button;
  return (
    <span className="btn-wrap">
      {button}
      <small id={reasonId} className="btn-reason">
        {disabledReason}
      </small>
    </span>
  );
}
