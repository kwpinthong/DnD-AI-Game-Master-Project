import { useState } from 'react';

type Errors<F extends string> = Partial<Record<F, string>>;

/**
 * Which error a form field shows (GEN-090 C2). `local` is the check of the values as typed now. A field's
 * local error shows once the player has left the field (or tried to send); an error the server gave stays
 * until that field is edited. `invalid` keeps the submit button off while any local check fails.
 */
export function useFieldErrors<F extends string>(local: Errors<F>) {
  const [touched, setTouched] = useState<Partial<Record<F, true>>>({});
  const [server, setServer] = useState<Errors<F>>({});

  return {
    invalid: Object.keys(local).length > 0,
    errorOf: (field: F): string | undefined => server[field] ?? (touched[field] ? local[field] : undefined),
    /** The player left the field. */
    touch: (field: F) => setTouched((t) => (t[field] ? t : { ...t, [field]: true })),
    /** The player tried to send: every field with a problem says so. */
    touchAll: () => setTouched(Object.fromEntries(Object.keys(local).map((f) => [f, true])) as Partial<Record<F, true>>),
    /** The field's value changed: what the server said about the old value no longer applies. */
    edited: (field: F) => setServer((s) => (field in s ? ({ ...s, [field]: undefined } as Errors<F>) : s)),
    setServer,
  };
}
