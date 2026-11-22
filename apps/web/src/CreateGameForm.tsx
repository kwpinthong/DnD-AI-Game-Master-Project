import { createGameFieldErrors, type CreateGameField, type GameView, type Member } from '@isekai/protocol';
import { useState, type FormEvent } from 'react';
import { postCreateGame, type CreateGameInput } from './game-api.ts';
import { PinInput } from './PinInput.tsx';

type TextField = 'createCode' | 'gameName' | 'name' | 'pin';

const textFields: { field: TextField; label: string; hint?: string; input: Record<string, string> }[] = [
  {
    field: 'createCode',
    label: 'Create code',
    hint: 'รหัสสร้างเกมของ server ขอจากคนดูแล server (ไม่ใช่โค้ดเกม)',
    input: { type: 'password', autoComplete: 'off' },
  },
  { field: 'gameName', label: 'ชื่อเกม', input: { autoComplete: 'off' } },
  { field: 'name', label: 'ชื่อผู้เล่นของคุณ', hint: 'ใช้เข้าเกมนี้ครั้งหน้า คู่กับ PIN', input: { autoComplete: 'username' } },
  {
    field: 'pin',
    label: 'PIN ของคุณ',
    hint: 'ตัวเลข 4-6 หลัก',
    input: {}, // rendered by PinInput below
  },
];

/** Game setup (GEN-044 wireframe 2, the parts GEN-025 builds): name, mode, Human GM, the creator's login. */
export function CreateGameForm({
  apiBaseUrl,
  onCreated,
  onBack,
}: {
  apiBaseUrl: string;
  onCreated: (member: Member, token: string, game: GameView) => void;
  onBack: () => void;
}) {
  const [values, setValues] = useState<CreateGameInput>({
    createCode: '',
    gameName: '',
    mode: 'online',
    humanGm: false,
    name: '',
    pin: '',
  });
  const [errors, setErrors] = useState<Partial<Record<CreateGameField, string>>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Single is AI GM only, so the Human GM choice is dropped with it.
  const body: CreateGameInput = { ...values, humanGm: values.mode === 'online' && values.humanGm };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    const local = createGameFieldErrors(body);
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    const result = await postCreateGame(apiBaseUrl, body);
    setBusy(false);
    if (result.ok) {
      onCreated(result.member, result.token, result.game);
      return;
    }
    setErrors(result.fields);
    setFormError(result.form);
  }

  return (
    <form className="setup-card" onSubmit={submit} noValidate>
      <button type="button" onClick={onBack}>
        &lt; กลับ
      </button>
      <h2>สร้างเกมใหม่</h2>
      {textFields.map(({ field, label, hint, input }) => {
        const id = `create-${field}`;
        const error = errors[field];
        const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');
        return (
          <div className="setup-field" key={field}>
            <label htmlFor={id}>{label}</label>
            {field === 'pin' ? (
              <PinInput
                id={id}
                name={field}
                value={values[field]}
                onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                aria-invalid={error ? 'true' : 'false'}
                aria-describedby={describedBy || undefined}
                autoComplete="new-password"
              />
            ) : (
              <input
                id={id}
                name={field}
                value={values[field]}
                onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                aria-invalid={error ? 'true' : 'false'}
                aria-describedby={describedBy || undefined}
                {...input}
              />
            )}
            {hint && <small id={`${id}-hint`}>{hint}</small>}
            {error && (
              <p id={`${id}-error`} className="setup-error" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <fieldset>
        <legend>โหมด</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={values.mode === 'online'}
            onChange={() => setValues((v) => ({ ...v, mode: 'online' }))}
          />
          Online 2-6 คน
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={values.mode === 'single'}
            onChange={() => setValues((v) => ({ ...v, mode: 'single' }))}
          />
          เล่นคนเดียว (AI GM)
        </label>
      </fieldset>
      {values.mode === 'online' && (
        <fieldset>
          <legend>Game Master</legend>
          <label>
            <input
              type="checkbox"
              checked={values.humanGm}
              onChange={(e) => setValues((v) => ({ ...v, humanGm: e.target.checked }))}
            />
            มี GM คน (คุณเป็น GM ไม่มีตัวละคร ไม่นับเป็นผู้เล่น)
          </label>
          {errors.humanGm && (
            <p className="setup-error" role="alert">
              {errors.humanGm}
            </p>
          )}
        </fieldset>
      )}
      {formError && (
        <p className="setup-error" role="alert">
          {formError}
        </p>
      )}
      <button type="submit" disabled={busy}>
        สร้างเกมและรับโค้ด
      </button>
    </form>
  );
}
