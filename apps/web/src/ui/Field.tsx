import type { ReactNode } from 'react';

/** What the control inside a Field must spread on its input / textarea. */
export interface FieldControl {
  id: string;
  'aria-invalid': 'true' | 'false';
  'aria-describedby': string | undefined;
}

/**
 * One form field (GEN-090): label, the control, a hint, and the error right under the control it belongs to.
 * The error is a role="alert" tied to the control with aria-describedby, and the control is aria-invalid, so
 * the state is never colour alone.
 */
export function Field({
  id,
  label,
  hint,
  note,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  /** A second line under the hint, e.g. a character counter. */
  note?: ReactNode;
  error?: string | undefined;
  children: (control: FieldControl) => ReactNode;
}) {
  const describedBy = [hint && `${id}-hint`, note && `${id}-note`, error && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className={error ? 'field field--invalid' : 'field'}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': error ? 'true' : 'false', 'aria-describedby': describedBy || undefined })}
      {error && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
      {hint && (
        <small id={`${id}-hint`} className="field__hint">
          {hint}
        </small>
      )}
      {note && (
        <small id={`${id}-note`} className="field__note">
          {note}
        </small>
      )}
    </div>
  );
}
