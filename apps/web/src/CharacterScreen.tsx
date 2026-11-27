import {
  APPEARANCE_CATEGORIES,
  CHARACTER_NAME_MAX_LENGTH,
  characterFieldErrors,
  PERSONALITY_MAX_LENGTH,
  type CharacterView,
  type LootView,
} from '@isekai/protocol';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AppearancePicker, completeTraits, missingLooks, looksSentence, NO_LOOKS, type Looks, type LooksOptions } from './AppearancePicker.tsx';
import { useFieldErrors } from './form-state.ts';
import { appearanceOptionsCall, characterCall, type LooksField } from './game-api.ts';
import { LootStep, lootSummary } from './LootStep.tsx';
import { Avatar } from './play/chat/Bubbles.tsx';
import { FeedbackButton } from './ui/FeedbackDialog.tsx';
import { Button, Field, Panel, Skeleton, Stepper, VisibilityBadge, type Visibility } from './ui/index.ts';
import './pregame.css';

const STEPS = ['ตัวตน', 'ของติดตัว', 'ตรวจทาน'] as const;
type Step = 0 | 1 | 2;

/** The typed fields; the looks (ISK-007) are picked in AppearancePicker. */
type TextField = 'name' | 'personality';
const fields: { field: TextField; label: string; sees: Visibility; hint: string; max: number; multiline: boolean }[] = [
  { field: 'name', label: 'ชื่อจริง', sees: 'secret', hint: 'เห็นคนเดียว จนเป็นพันธมิตรสนิท', max: CHARACTER_NAME_MAX_LENGTH, multiline: false },
  { field: 'personality', label: 'บุคลิก', sees: 'secret', hint: 'ไม่มีใครเห็น ใช้หาจุดแข็ง จุดอ่อน และของติดตัวในขั้นถัดไป', max: PERSONALITY_MAX_LENGTH, multiline: true },
];

/** Code points, the unit the server counts (Thai vowel and tone marks count as one each). */
function remaining(value: string, max: number): string {
  const left = max - [...value].length;
  return left >= 0 ? `เหลือ ${left} ตัวอักษร` : `เกิน ${-left} ตัวอักษร`;
}

type Identity = Record<TextField, string>;
const empty: Identity = { name: '', personality: '' };
const identityOf = (c: CharacterView): Identity => ({ name: c.name, personality: c.personality });
const looksOf = (c: CharacterView): Looks => {
  const { extra = '', ...traits } = c.appearanceTraits ?? {};
  return { avatarId: c.avatarId, traits, extra };
};
const sameLooks = (a: Looks, b: Looks) => a.avatarId === b.avatarId && a.extra.trim() === b.extra.trim() && APPEARANCE_CATEGORIES.every((c) => a.traits[c] === b.traits[c]);

/** ISK-007 (8): the unsaved avatar + chips + free text per game, in sessionStorage; a blocked storage only loses the draft. */
const draftKey = (gameId: string) => `charDraft:${gameId}`;
function readDraft(gameId: string | undefined): Looks | null {
  if (!gameId) return null;
  try {
    const raw = sessionStorage.getItem(draftKey(gameId));
    const draft = raw ? (JSON.parse(raw) as Partial<Looks>) : null;
    if (!draft || typeof draft !== 'object') return null;
    return { avatarId: typeof draft.avatarId === 'string' ? draft.avatarId : null, traits: typeof draft.traits === 'object' && draft.traits ? draft.traits : {}, extra: typeof draft.extra === 'string' ? draft.extra : '' };
  } catch {
    return null;
  }
}
function writeDraft(gameId: string | undefined, looks: Looks | null) {
  if (!gameId) return;
  try {
    if (looks) sessionStorage.setItem(draftKey(gameId), JSON.stringify(looks));
    else sessionStorage.removeItem(draftKey(gameId));
  } catch {
    // shortcut: a blocked storage means no draft across a reload, the form itself keeps working.
  }
}

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
  gameId,
}: {
  apiBaseUrl: string;
  token: string;
  onBack: () => void;
  onSessionLost: () => void;
  /** The game has started: open the play room instead of this page. */
  onGameStarted?: () => void;
  /** Keys the looks draft (ISK-007); left out = no draft. */
  gameId?: string | undefined;
}) {
  /** undefined while loading; null when the player has no character yet. */
  const [character, setCharacter] = useState<CharacterView | null>();
  const [step, setStep] = useState<Step>(0);
  const [values, setValues] = useState<Identity>(empty);
  const [draft] = useState(() => readDraft(gameId));
  const [looks, setLooks] = useState<Looks>(draft ?? NO_LOOKS);
  const [options, setOptions] = useState<LooksOptions>({ kind: 'loading' });
  const [optionsTry, setOptionsTry] = useState(0);
  const [looksErrors, setLooksErrors] = useState<Partial<Record<LooksField, string>>>({});
  const [missing, setMissing] = useState<string>();
  const [loot, setLoot] = useState<LootView>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const errors = useFieldErrors<TextField>(characterFieldErrors(values));
  const labels = options.kind === 'ok' ? options.labels : undefined;

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
        // An unsaved draft wins over what was saved; a character made before ISK-006 has no looks to fill in.
        if (!draft && result.character.avatarId) setLooks(looksOf(result.character));
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
    let cancelled = false;
    setOptions({ kind: 'loading' });
    void appearanceOptionsCall(apiBaseUrl).then((result) => {
      if (!cancelled) setOptions(result.kind === 'ok' ? { kind: 'ok', labels: result.labels } : result);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, optionsTry]);

  function changeLooks(next: Looks, field: LooksField) {
    setLooks(next);
    // A new avatar rewrites every chip, so every message about them goes.
    setLooksErrors(({ [field]: _gone, ...rest }) => (field === 'avatar' ? {} : rest));
    setMissing(undefined);
    writeDraft(gameId, next);
  }

  useEffect(() => {
    if (started) onGameStarted?.();
  }, [started]);

  async function saveIdentity(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    if (errors.invalid) return errors.touchAll();
    if (busy) return;
    const notChosen = missingLooks(looks, labels);
    if (notChosen.length > 0) return setMissing(`ยังไม่เลือก${notChosen.join(', ')}`);
    // Nothing changed: go on without asking the server (an edit of the personality would clear the loot).
    const before = character ? identityOf(character) : null;
    if (before && character && fields.every(({ field }) => before[field] === values[field]) && sameLooks(looksOf(character), looks)) return setStep(1);

    setBusy(true);
    const body = { ...values, avatarId: looks.avatarId!, appearanceTraits: completeTraits(looks, labels)! };
    const result = await characterCall(apiBaseUrl, token, character ? 'PUT' : 'POST', body);
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'invalid') return errors.setServer(result.fields);
    if (result.kind === 'looks') return setLooksErrors({ [result.field]: result.message });
    if (result.kind === 'error') return setFormError(result.message);
    writeDraft(gameId, null);
    setCharacter(result.character);
    // The loot step loads again: a changed personality clears what was kept (Q-081).
    setLoot(undefined);
    if (result.character?.editable) setStep(1);
  }

  const back = (
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
    ['ลักษณะ', looksSentence(looks, labels) ?? '-'],
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
                <AppearancePicker looks={looks} options={options} errors={looksErrors} onChange={changeLooks} onRetry={() => setOptionsTry((n) => n + 1)} />
                {missing && (
                  <p className="field-error pregame__form-error" role="alert">
                    {missing}
                  </p>
                )}
                {character && <p className="pregame__note">แก้บุคลิกแล้วของติดตัวที่เลือกไว้จะถูกล้าง ต้องให้ AI วิเคราะห์บุคลิกใหม่</p>}
                {formError && (
                  <p className="field-error pregame__form-error" role="alert">
                    {formError}
                  </p>
                )}
                <div className="pregame__actions">
                  <Button type="submit" variant="primary" disabled={errors.invalid} loading={busy} loadingText="กำลังบันทึก…" disabledReason="ใส่ชื่อจริงและบุคลิกให้ครบก่อน">
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
              <div className="review__who">
                <Avatar name={character.name} avatarId={character.avatarId} own size="lg" />
                <h3 className="review__name display">{character.name}</h3>
              </div>
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
                <Button variant="primary" onClick={onBack}>
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
