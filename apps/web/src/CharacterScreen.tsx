import {
  APPEARANCE_MAX_LENGTH,
  CHARACTER_NAME_MAX_LENGTH,
  characterFieldErrors,
  PERSONALITY_MAX_LENGTH,
  type CharacterField,
  type CharacterRequest,
  type CharacterView,
} from '@isekai/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { characterCall } from './game-api.ts';
import { LootStep } from './LootStep.tsx';

const fields: { field: CharacterField; label: string; hint: string; max: number; multiline: boolean }[] = [
  {
    field: 'name',
    label: 'ชื่อจริง',
    hint: 'เห็นคนเดียว คนอื่นรู้เมื่อคุณบอกเอง',
    max: CHARACTER_NAME_MAX_LENGTH,
    multiline: false,
  },
  {
    field: 'appearance',
    label: 'ลักษณะภายนอก',
    hint: 'ทุกคนเห็น ใช้เรียกคุณแทนชื่อ',
    max: APPEARANCE_MAX_LENGTH,
    multiline: true,
  },
  {
    field: 'personality',
    label: 'บุคลิก',
    hint: 'ไม่มีใครเห็น ใช้หาจุดแข็ง จุดอ่อน และของติดตัวในขั้นถัดไป',
    max: PERSONALITY_MAX_LENGTH,
    multiline: true,
  },
];

/** Code points, the unit the server counts (Thai vowel and tone marks count as one each). */
function remaining(value: string, max: number): string {
  const left = max - [...value].length;
  return left >= 0 ? `เหลือ ${left} ตัวอักษร` : `เกิน ${-left} ตัวอักษร`;
}

const empty: CharacterRequest = { name: '', appearance: '', personality: '' };

/**
 * Character creation step 1 (GEN-044 wireframe 3, "ตัวตน"): name, appearance, personality, then
 * the saved character with its starting values. The player never sees Karma or the Reputation
 * number, only the Social Title. Steps 2-3 (items, origin) come with later tasks.
 */
export function CharacterScreen({
  apiBaseUrl,
  token,
  onBack,
  onSessionLost,
}: {
  apiBaseUrl: string;
  token: string;
  onBack: () => void;
  onSessionLost: () => void;
}) {
  /** undefined while loading; null when the player has no character yet. */
  const [character, setCharacter] = useState<CharacterView | null>();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<CharacterRequest>(empty);
  const [errors, setErrors] = useState<Partial<Record<CharacterField, string>>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void characterCall(apiBaseUrl, token, 'GET').then((result) => {
      if (cancelled) return;
      if (result.kind === 'session_lost') onSessionLost();
      else if (result.kind === 'ok') setCharacter(result.character);
      else setFormError(result.kind === 'error' ? result.message : 'โหลดตัวละครไม่ได้');
    });
    return () => {
      cancelled = true;
    };
    // Loaded once per token.
  }, [apiBaseUrl, token]);

  function startEditing(from: CharacterView) {
    setValues({ name: from.name, appearance: from.appearance, personality: from.personality });
    setErrors({});
    setFormError(undefined);
    setEditing(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    const local = characterFieldErrors(values);
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    const result = await characterCall(apiBaseUrl, token, character ? 'PUT' : 'POST', values);
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'invalid') return setErrors(result.fields);
    if (result.kind === 'error') return setFormError(result.message);
    setCharacter(result.character);
    setEditing(false);
  }

  const back = (
    <button type="button" onClick={onBack}>
      กลับห้องรอ
    </button>
  );

  if (character === undefined) {
    return (
      <section aria-label="สร้างตัวละคร">
        {back}
        {formError ? <p role="alert">โหลดตัวละครไม่ได้: {formError}</p> : <p>กำลังโหลดตัวละคร…</p>}
      </section>
    );
  }

  if (character && !editing) {
    return (
      <section className="setup-card" aria-label="ตัวละครของคุณ">
        {back}
        <h2>{character.name}</h2>
        <p>{character.appearance}</p>
        <p>
          <small>บุคลิก (ไม่มีใครเห็น)</small>
        </p>
        <p>{character.personality}</p>
        <ul aria-label="ค่าเริ่มต้น">
          <li>
            HP {character.hp.current}/{character.hp.max}
          </li>
          <li>
            Stamina {character.stamina.current}/{character.stamina.max}
          </li>
          <li>ฉายา: {character.socialTitle}</li>
          <li>ความประพฤติ: {character.conduct}</li>
        </ul>
        {character.editable ? (
          <button type="button" onClick={() => startEditing(character)}>
            แก้ไข
          </button>
        ) : (
          <p role="status">เกมเริ่มแล้ว แก้ตัวตนไม่ได้</p>
        )}
        <LootStep apiBaseUrl={apiBaseUrl} token={token} onSessionLost={onSessionLost} />
      </section>
    );
  }

  return (
    <form className="setup-card" aria-label="สร้างตัวละคร" onSubmit={submit} noValidate>
      {back}
      <h2>สร้างตัวละคร</h2>
      <p>
        <strong>[ตัวตน]</strong> &gt; ของติดตัว &gt; จุดกำเนิด
      </p>
      {fields.map(({ field, label, hint, max, multiline }) => {
        const id = `character-${field}`;
        const error = errors[field];
        const describedBy = [`${id}-hint`, `${id}-count`, error && `${id}-error`].filter(Boolean).join(' ');
        const common = {
          id,
          name: field,
          value: values[field],
          'aria-invalid': error ? ('true' as const) : ('false' as const),
          'aria-describedby': describedBy,
        };
        return (
          <div className="setup-field" key={field}>
            <label htmlFor={id}>{label}</label>
            {multiline ? (
              <textarea {...common} rows={4} onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))} />
            ) : (
              <input {...common} autoComplete="off" onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))} />
            )}
            <small id={`${id}-hint`}>{hint}</small> <small id={`${id}-count`}>{remaining(values[field], max)}</small>
            {error && (
              <p id={`${id}-error`} className="setup-error" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
      {formError && (
        <p className="setup-error" role="alert">
          {formError}
        </p>
      )}
      {editing && (
        <button type="button" onClick={() => setEditing(false)}>
          ยกเลิก
        </button>
      )}{' '}
      <button type="submit" disabled={busy}>
        บันทึกตัวละคร
      </button>
    </form>
  );
}
