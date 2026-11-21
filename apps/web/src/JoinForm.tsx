import { joinFieldErrors, type JoinField, type Member } from '@isekai/protocol';
import { useState, type FormEvent } from 'react';
import { postJoin } from './session.ts';

type Values = Record<JoinField, string>;

const fields: { field: JoinField; label: string; hint?: string; input: Record<string, string> }[] = [
  { field: 'inviteCode', label: 'โค้ดเกม', input: { autoComplete: 'off', autoCapitalize: 'characters' } },
  {
    field: 'name',
    label: 'ชื่อผู้เล่น',
    hint: 'ชื่อนี้คนอื่นไม่เห็นในเกม ใช้เข้าระบบเท่านั้น',
    input: { autoComplete: 'username' },
  },
  {
    field: 'pin',
    label: 'PIN',
    hint: 'ตัวเลข 4-6 หลัก ครั้งแรกที่เข้าเกมนี้ PIN ที่ใส่จะเป็น PIN ของชื่อนี้',
    input: { type: 'password', inputMode: 'numeric', autoComplete: 'current-password' },
  },
];

/** Join screen (GEN-044 wireframe 1): invite code + player name + PIN in one card. */
export function JoinForm({ apiBaseUrl, onJoined }: { apiBaseUrl: string; onJoined: (member: Member, token: string) => void }) {
  const [values, setValues] = useState<Values>({ inviteCode: '', name: '', pin: '' });
  const [errors, setErrors] = useState<Partial<Values>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    const local = joinFieldErrors(values);
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    const result = await postJoin(apiBaseUrl, values);
    setBusy(false);
    if (result.ok) {
      onJoined(result.member, result.token);
      return;
    }
    setErrors(result.fields);
    setFormError(result.form);
  }

  return (
    <form className="join-card" onSubmit={submit} noValidate>
      <h2>เข้าร่วมเกม</h2>
      {fields.map(({ field, label, hint, input }) => {
        const id = `join-${field}`;
        const error = errors[field];
        const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
        return (
          <div className="join-field" key={field}>
            <label htmlFor={id}>{label}</label>
            <input
              id={id}
              name={field}
              value={values[field]}
              onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
              aria-invalid={error ? 'true' : 'false'}
              aria-describedby={describedBy || undefined}
              {...input}
            />
            {hint && (
              <small id={`${id}-hint`} className="join-hint">
                {hint}
              </small>
            )}
            {error && (
              <p id={`${id}-error`} className="join-error" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
      {formError && (
        <p className="join-error" role="alert">
          {formError}
        </p>
      )}
      <button type="submit" disabled={busy}>
        เข้าร่วม
      </button>
      <p className="join-hint">ลืม PIN? ขอให้เจ้าของเกมรีเซ็ตให้</p>
    </form>
  );
}
