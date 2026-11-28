import {
  APPEARANCE_MAX_LENGTH,
  CHARACTER_NAME_MAX_LENGTH,
  characterFieldErrors,
  PERSONALITY_MAX_LENGTH,
  type CharacterField,
  type CharacterView,
  type LootView,
} from '@isekai/protocol';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useFieldErrors } from './form-state.ts';
import { characterCall } from './game-api.ts';
import { LootStep, lootSummary } from './LootStep.tsx';
import { FeedbackButton } from './ui/FeedbackDialog.tsx';
import { Button, Field, Panel, Skeleton, Stepper, VisibilityBadge, type Visibility } from './ui/index.ts';
import './pregame.css';

const STEPS = ['ตัวตน', 'ของติดตัว', 'ตรวจทาน'] as const;
type Step = 0 | 1 | 2;

const fields: { field: CharacterField; label: string; sees: Visibility; hint: string; max: number; multiline: boolean }[] = [
  { field: 'name', label: 'ชื่อจริง', sees: 'secret', hint: 'เห็นคนเดียว จนเป็นพันธมิตรสนิท', max: CHARACTER_NAME_MAX_LENGTH, multiline: false },
  { field: 'appearance', label: 'ลักษณะภายนอก', sees: 'public', hint: 'ทุกคนเห็น ใช้เรียกคุณแทนชื่อ', max: APPEARANCE_MAX_LENGTH, multiline: true },
  { field: 'personality', label: 'บุคลิก', sees: 'secret', hint: 'ไม่มีใครเห็น ใช้หาจุดแข็ง จุดอ่อน และของติดตัวในขั้นถัดไป', max: PERSONALITY_MAX_LENGTH, multiline: true },
];

/** Code points, the unit the server counts (Thai vowel and tone marks count as one each). */
function remaining(value: string, max: number): string {
  const left = max - [...value].length;
  return left >= 0 ? `เหลือ ${left} ตัวอักษร` : `เกิน ${-left} ตัวอักษร`;
}

/** shortcut: the GEN-047 text form; ISK-007 replaces `appearance` with the avatar + chips the server now requires. */
type Identity = Record<CharacterField, string>;
const empty: Identity = { name: '', appearance: '', personality: '' };
const identityOf = (c: CharacterView): Identity => ({ name: c.name, appearance: c.appearance, personality: c.personality });

/**
 * Character creation v2 (GEN-090, Screens and Flows v2 §3): three steps, ตัวตน → ของติดตัว → ตรวจทาน, with
 * the step bar saying where you are ("ขั้นที่ 2 / 3"). Every earlier step can be opened and changed again
 * until the game starts (C1). The origin is not a step: the server rolls it at the start and the origin
 * card shows it on the way into Play. Once the game has started nothing here can change, so the page asks
 * for the play room instead (C4). The player never sees Karma or the Reputation number, only words.
 */
export function CharacterScreen({
  apiBaseUrl,
  token,
  onBack,
  onSessionLost,
  onGameStarted,
  onConfirm = onBack,
}: {
  apiBaseUrl: string;
  token: string;
  /** กลับห้องรอ; none = no lobby to go back to (ISK-016 late joiner). */
  onBack?: () => void;
  /** ยืนยันตัวละคร (default: back to the lobby). */
  onConfirm?: (() => void) | undefined;
  onSessionLost: () => void;
  /** The game has started: open the play room instead of this page. */
  onGameStarted?: () => void;
}) {
  /** undefined while loading; null when the player has no character yet. */
  const [character, setCharacter] = useState<CharacterView | null>();
  const [step, setStep] = useState<Step>(0);
  const [values, setValues] = useState<Identity>(empty);
  const [loot, setLoot] = useState<LootView>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const errors = useFieldErrors<CharacterField>(characterFieldErrors(values));

  const started = character ? !character.editable : false;

  useEffect(() => {
    let cancelled = false;
    void characterCall(apiBaseUrl, token, 'GET').then((result) => {
      if (cancelled) return;
      if (result.kind === 'session_lost') return onSessionLost();
      if (result.kind !== 'ok') return setFormError(result.kind === 'error' ? result.message : 'โหลดตัวละครไม่ได้');
      setCharacter(result.character);
      if (result.character) {
        setValues(identityOf(result.character));
        // With an identity already saved, the page opens on the step that still needs a choice.
        setStep(1);
      }
    });
    return () => {
      cancelled = true;
    };
    // Loaded once per token.
  }, [apiBaseUrl, token]);

  useEffect(() => {
    if (started) onGameStarted?.();
  }, [started]);

  async function saveIdentity(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    if (errors.invalid) return errors.touchAll();
    if (busy) return;
    // Nothing changed: go on without asking the server (an edit of the personality would clear the loot).
    const before = character ? identityOf(character) : null;
    if (before && fields.every(({ field }) => before[field] === values[field])) return setStep(1);

    setBusy(true);
    const result = await characterCall(apiBaseUrl, token, character ? 'PUT' : 'POST', values);
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'invalid') return errors.setServer(result.fields);
    if (result.kind === 'error') return setFormError(result.message);
    setCharacter(result.character);
    // The loot step loads again: a changed personality clears what was kept (Q-081).
    setLoot(undefined);
    if (result.character?.editable) setStep(1);
  }

  const back = onBack && (
    <Button className="pregame__back" onClick={onBack}>
      กลับห้องรอ
    </Button>
  );

  if (character === undefined) {
    return (
      <div className="pregame">
        <section aria-label="สร้างตัวละคร">
          {back}
          {formError ? <p role="alert">โหลดตัวละครไม่ได้: {formError}</p> : <Skeleton lines={4} label="กำลังโหลดตัวละคร…" />}
        </section>
      </div>
    );
  }

  if (character && started) {
    return (
      <div className="pregame">
        <Panel title="สร้างตัวละคร" className="pregame__panel">
          <h2 className="pregame__title">{character.name}</h2>
          <p role="status">เกมเริ่มแล้ว แก้ตัวละครไม่ได้ ตัวละครและของติดตัวของคุณอยู่ในหน้าเล่น</p>
          <div className="pregame__actions">
            <Button variant="primary" onClick={() => onGameStarted?.()}>
              ไปหน้าเล่น
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  const canOpen = (index: number) => index === 0 || (character !== null && (index === 1 || Boolean(loot?.chosen)));
  const chosen = loot?.chosen ?? null;

  const summaryRows: [string, ReactNode][] = [
    ['ชื่อจริง', values.name.trim() || '-'],
    ['ลักษณะ', values.appearance.trim() || '-'],
    ['ความสามารถ', chosen ? chosen.skill.name : '-'],
    ['ของติดตัว', chosen ? chosen.item.name : '-'],
  ];

  return (
    <div className="pregame pregame--wide">
      <FeedbackButton apiBaseUrl={apiBaseUrl} token={token} page={step === 1 ? 'loot' : 'character'} />
      <div className="wizard__head">
        {back}
        <h2 className="pregame__title">สร้างตัวละคร</h2>
      </div>
      <Stepper label="ขั้นตอนสร้างตัวละคร" steps={STEPS} current={step} canOpen={canOpen} onOpen={(index) => setStep(index as Step)} />

      <div className={step === 2 ? 'wizard wizard--review' : 'wizard'}>
        <div className="wizard__main">
          {step === 0 && (
            <Panel title="ตัวตน" className="pregame__panel">
              <form aria-label="สร้างตัวละคร" onSubmit={saveIdentity} noValidate>
                {fields.map(({ field, label, sees, hint, max, multiline }) => (
                  <Field
                    key={field}
                    id={`character-${field}`}
                    label={label}
                    error={errors.errorOf(field)}
                    hint={
                      <>
                        <VisibilityBadge visibility={sees} /> {hint}
                      </>
                    }
                    note={remaining(values[field], max)}
                  >
                    {(control) => {
                      const common = {
                        ...control,
                        name: field,
                        value: values[field],
                        onBlur: () => errors.touch(field),
                        onChange: (e: { target: { value: string } }) => {
                          setValues((v) => ({ ...v, [field]: e.target.value }));
                          errors.edited(field);
                        },
                      };
                      return multiline ? <textarea {...common} rows={4} /> : <input {...common} autoComplete="off" />;
                    }}
                  </Field>
                ))}
                {character && <p className="pregame__note">แก้บุคลิกแล้วของติดตัวที่เลือกไว้จะถูกล้าง ต้องให้ AI วิเคราะห์บุคลิกใหม่</p>}
                {formError && (
                  <p className="field-error pregame__form-error" role="alert">
                    {formError}
                  </p>
                )}
                <div className="pregame__actions">
                  <Button type="submit" variant="primary" disabled={errors.invalid} loading={busy} loadingText="กำลังบันทึก…" disabledReason="ใส่ชื่อจริง ลักษณะภายนอก และบุคลิกให้ครบก่อน">
                    ถัดไป: ของติดตัว
                  </Button>
                </div>
              </form>
            </Panel>
          )}

          {step === 1 && (
            <Panel title="ขั้นของติดตัว" className="pregame__panel">
              <LootStep apiBaseUrl={apiBaseUrl} token={token} onSessionLost={onSessionLost} onLoot={setLoot} />
              <p className="pregame__note">แก้บุคลิกในขั้นตัวตน = ล้างของติดตัวที่เลือกไว้</p>
              <div className="pregame__actions pregame__actions--split">
                <Button onClick={() => setStep(0)}>ย้อนกลับ</Button>
                <Button variant="primary" disabled={!chosen} disabledReason="เลือกความสามารถและของติดตัวให้ครบก่อน" onClick={() => setStep(2)}>
                  ถัดไป: ตรวจทาน
                </Button>
              </div>
            </Panel>
          )}

          {step === 2 && character && (
            <Panel title="ตัวละครของคุณ" className="pregame__panel review">
              <h3 className="review__name display">{character.name}</h3>
              <dl className="review__list">
                <dt>
                  ลักษณะภายนอก <VisibilityBadge visibility="public" />
                </dt>
                <dd>{character.appearance}</dd>
                <dt>
                  บุคลิก <VisibilityBadge visibility="secret" />
                </dt>
                <dd>{character.personality}</dd>
              </dl>
              <ul aria-label="ค่าเริ่มต้น" className="review__stats">
                <li>
                  HP {character.hp.current}/{character.hp.max}
                </li>
                <li>
                  Stamina {character.stamina.current}/{character.stamina.max}
                </li>
                <li>ฉายา: {character.socialTitle}</li>
                <li>ความประพฤติ: {character.conduct}</li>
              </ul>
              {character.statuses.length > 0 ? (
                <ul aria-label="สถานะ" className="review__stats">
                  {character.statuses.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              ) : null}
              {chosen && (
                <ul aria-label="ของติดตัวที่จะใช้" className="loot__kept">
                  <li>จุดแข็ง: {chosen.strength.label}</li>
                  <li>จุดอ่อน: {chosen.weakness.label}</li>
                  <li>ความสามารถ: {lootSummary(chosen.skill)}</li>
                  <li>ของติดตัว: {lootSummary(chosen.item)}</li>
                </ul>
              )}
              <p className="pregame__note">จุดเกิดของคุณจะสุ่มตอนเกมเริ่ม จาก 15 แบบ (บางแบบหายาก) แล้วแสดงเป็นการ์ดตอนเข้าหน้าเล่น</p>
              <p className="pregame__note">ยังกลับมาแก้ได้ทุกขั้นจนกว่าเจ้าของเกมจะกดเริ่มเกม</p>
              <div className="pregame__actions pregame__actions--split">
                <Button onClick={() => setStep(1)}>ย้อนกลับ</Button>
                <Button variant="primary" onClick={onConfirm}>
                  ยืนยันตัวละคร
                </Button>
              </div>
            </Panel>
          )}
        </div>

        {step !== 2 && (
          <aside className="wizard__summary" aria-label="สรุปตัวละคร" data-open={summaryOpen}>
            <Button className="wizard__summary-toggle" aria-expanded={summaryOpen} onClick={() => setSummaryOpen((open) => !open)}>
              {summaryOpen ? 'ซ่อนสรุป' : 'ดูสรุป'}
            </Button>
            <dl className="wizard__summary-body">
              {summaryRows.map(([term, value]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}
