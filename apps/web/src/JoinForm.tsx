import { joinFieldErrors, type JoinField, type Member } from '@isekai/protocol';
import { useState, type FormEvent } from 'react';
import keyart from './assets/illustrations/home-keyart.webp';
import { useFieldErrors } from './form-state.ts';
import { PinInput } from './PinInput.tsx';
import { postJoin } from './session.ts';
import { Button, Field, Panel } from './ui/index.ts';
import './pregame.css';
import './home-art.css';

type Values = Record<JoinField, string>;

/**
 * Join screen v2 (GEN-090, Screens and Flows v2 §1): invite code + player name + PIN in one form. A field
 * says what is wrong once the player leaves it and the join button stays off until all three pass (C2).
 * GEN-082: the optional player code + style opt-out (`JoinStyleFields`) go in the same body; the server keeps
 * only a hash of the code.
 */
export function JoinForm({ apiBaseUrl, onJoined, notice }: { apiBaseUrl: string; onJoined: (member: Member, token: string) => void; notice?: string }) {
  const [values, setValues] = useState<Values>({ inviteCode: '', name: '', pin: '' });
  const [playerCode, setPlayerCode] = useState('');
  const [noStyle, setNoStyle] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(notice);
  const [busy, setBusy] = useState(false);
  const errors = useFieldErrors<JoinField>(joinFieldErrors(values));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    if (errors.invalid) return errors.touchAll();
    if (busy) return;

    setBusy(true);
    // Only what the player filled in: an empty code / unticked box changes nothing on a rejoin.
    const code = playerCode.trim();
    const result = await postJoin(apiBaseUrl, { ...values, ...(code ? { playerCode: code } : {}), ...(noStyle ? { noStyle } : {}) });
    setBusy(false);
    if (result.ok) return onJoined(result.member, result.token);
    errors.setServer(result.fields);
    setFormError(result.form);
  }

  const bind = (field: JoinField) => ({
    name: field,
    value: values[field],
    onChange: (e: { target: { value: string } }) => {
      setValues((v) => ({ ...v, [field]: e.target.value }));
      errors.edited(field);
    },
    onBlur: () => errors.touch(field),
  });

  return (
    <div className="pregame">
      {/* the painting has no words in it, so it is decoration */}
      <img className="pregame__keyart" src={keyart} alt="" width={1024} height={683} />
      <Panel title="เข้าร่วมเกม" className="pregame__panel">
        <form onSubmit={submit} noValidate>
          <h2 className="pregame__title">เข้าร่วมเกม</h2>
          <p className="pregame__lead">ใส่โค้ดเกมที่เจ้าของเกมส่งให้ แล้วตั้งชื่อกับ PIN ของคุณ</p>
          <Field id="join-inviteCode" label="โค้ดเกม" error={errors.errorOf('inviteCode')}>
            {(control) => <input {...control} {...bind('inviteCode')} className="code-input" autoComplete="off" autoCapitalize="characters" spellCheck={false} />}
          </Field>
          <Field id="join-name" label="ชื่อผู้เล่น" hint="ชื่อนี้ใช้เข้าระบบ ในเกมไม่มีใครเห็น" error={errors.errorOf('name')}>
            {(control) => <input {...control} {...bind('name')} autoComplete="username" />}
          </Field>
          <Field
            id="join-pin"
            label="PIN"
            hint="ตัวเลข 4-6 หลัก ครั้งแรกที่เข้าเกมนี้ PIN ที่ใส่จะเป็น PIN ของชื่อนี้"
            error={errors.errorOf('pin')}
          >
            {(control) => <PinInput {...control} {...bind('pin')} autoComplete="current-password" />}
          </Field>
          <Field id="join-playerCode" label="รหัสผู้เล่น (ไม่บังคับ)" hint="ตั้งรหัสของคุณเอง แล้วใช้รหัสเดิมทุกเกม ระบบจะจำสไตล์การเล่นของคุณข้ามเกม ไม่มีใครเห็นรหัสนี้">
            {(control) => (
              <input {...control} name="playerCode" value={playerCode} onChange={(e) => setPlayerCode(e.target.value)} className="code-input" autoComplete="off" spellCheck={false} maxLength={64} />
            )}
          </Field>
          <label className="check">
            <input type="checkbox" checked={noStyle} onChange={(e) => setNoStyle(e.target.checked)} />
            <span>ไม่ต้องเก็บสไตล์ของฉัน</span>
          </label>
          {formError && (
            <p className="field-error pregame__form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="pregame__actions">
            <Button type="submit" variant="primary" disabled={errors.invalid} loading={busy} loadingText="กำลังเข้าร่วม…" disabledReason="ใส่โค้ดเกม ชื่อ และ PIN ให้ครบก่อน">
              เข้าร่วม
            </Button>
          </div>
          <p className="pregame__foot">ลืม PIN? ขอให้เจ้าของเกมรีเซ็ตให้</p>
        </form>
      </Panel>
    </div>
  );
}
