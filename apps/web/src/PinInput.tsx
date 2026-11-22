import { useState, type InputHTMLAttributes } from 'react';

type PinInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'inputMode'> & {
  /** `new-password` when the PIN is being set (create game), so the browser does not fill an old password. */
  autoComplete: 'new-password' | 'current-password';
};

/**
 * A PIN field with a show / hide button (GEN-092): hidden by default, but a player on a Thai
 * keyboard can look and see that the number row typed ๅ/-ภ instead of 1234.
 */
export function PinInput(props: PinInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <span className="pin-input">
      <input {...props} type={shown ? 'text' : 'password'} inputMode="numeric" spellCheck={false} />
      <button type="button" onClick={() => setShown((s) => !s)}>
        {shown ? 'ซ่อน PIN' : 'แสดง PIN'}
      </button>
    </span>
  );
}
