import { createGameFieldErrors, defaultScenario, MEMORY_MAX_SOURCES, type CreateGameField, type GameView, type Member, type MemorySourceGame, type Scenario } from '@isekai/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { useFieldErrors } from './form-state.ts';
import { memorySourcesCall, postCreateGame, type CreateGameInput } from './game-api.ts';
import { NpcDialoguePicker } from './NpcDialoguePicker.tsx';
import { ScenarioEditor } from './ScenarioEditor.tsx';
import { TonePicker } from './TonePicker.tsx';
import { createGameText, toneText } from './ui/strings.ts';
import { PinInput } from './PinInput.tsx';
import { Button, Field, Panel } from './ui/index.ts';
import './pregame.css';

type TextField = 'createCode' | 'gameName' | 'name' | 'pin';
type Base = Omit<CreateGameInput, 'playerCode' | 'noStyle' | 'memory' | 'scenario'>;

/** ISK-019: the half-filled form of this tab. The create code and the PIN are never kept. */
export const CREATE_DRAFT_KEY = 'createDraft';
export interface CreateDraft {
  values: Partial<Base>;
  scenario?: Scenario;
}

const EMPTY: Base = { createCode: '', gameName: '', mode: 'online', humanGm: false, npcDialogue: 'normal', name: '', pin: '' };

// sessionStorage can throw (blocked site data, private mode): the form then simply works without a draft.
function loadDraft(): CreateDraft | undefined {
  try {
    const raw = sessionStorage.getItem(CREATE_DRAFT_KEY);
    const draft = raw ? (JSON.parse(raw) as CreateDraft) : undefined;
    return draft && typeof draft.values === 'object' ? draft : undefined;
  } catch {
    return undefined;
  }
}
function saveDraft(draft: CreateDraft): void {
  try {
    sessionStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // no storage: no draft
  }
}
function dropDraft(): void {
  try {
    sessionStorage.removeItem(CREATE_DRAFT_KEY);
  } catch {
    // no storage: nothing kept
  }
}

const listSizes = (s: Scenario | undefined) => (s ? `${s.timeline.length}/${s.npcs.length}/${s.legendaries.length}` : '');

const endedOn = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });

/**
 * Create game v2 (GEN-090, Screens and Flows v2 §2): create code, game name, mode, Human GM and the
 * creator's own login. A field says what is wrong once the creator leaves it; the create button stays off
 * until everything passes (C2). "ความทรงจำจากเกมก่อน" (GEN-083, off by default) lists the ended games found by
 * the creator's player code (Q-225); with none the toggle stays off and says why.
 * ISK-019: every setting is fixed here, in one POST /api/games; the Human GM's game has a scenario step (skipped = the
 * default). The half-filled form is kept in sessionStorage until the game is created or [ยกเลิก].
 */
export function CreateGameForm({
  apiBaseUrl,
  onCreated,
  onBack,
  draft: given,
}: {
  apiBaseUrl: string;
  onCreated: (member: Member, token: string, game: GameView) => void;
  onBack: () => void;
  /** The gallery's filled form; the app reads the tab's draft instead. */
  draft?: CreateDraft;
}) {
  const [start] = useState(() => given ?? loadDraft());
  const [values, setValues] = useState<Base>(() => ({ ...EMPTY, ...start?.values, ...(given ? {} : { createCode: '', pin: '' }) }));
  const [scenario, setScenario] = useState<Scenario | undefined>(start?.scenario);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [scenarioFields, setScenarioFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (given) return;
    const { createCode: _code, pin: _pin, ...kept } = values;
    saveDraft({ values: kept, ...(scenario ? { scenario } : {}) });
  }, [values, scenario]);

  const [memoryOn, setMemoryOn] = useState(false);
  const [playerCode, setPlayerCode] = useState('');
  const [noStyle, setNoStyle] = useState(false);
  /** undefined = not looked up yet. */
  const [sources, setSources] = useState<MemorySourceGame[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [sourcesError, setSourcesError] = useState<string>();
  const [looking, setLooking] = useState(false);

  // Single is AI GM only, so the Human GM choice is dropped with it.
  const base: Base = { ...values, humanGm: values.mode === 'online' && values.humanGm };
  // Q-028: only the Human GM's game has a scenario step; in an AI GM game the creator is a player, who never sees it.
  const scenarioStep = base.humanGm;
  const errors = useFieldErrors<CreateGameField>(createGameFieldErrors(base));
  const noSources = !sources || sources.length === 0;
  const memoryMissing = memoryOn && picked.length === 0;
  const blocked = errors.invalid || memoryMissing;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    if (blocked) return errors.touchAll();
    if (busy) return;

    const code = playerCode.trim();
    const body: CreateGameInput = {
      ...base,
      ...(code === '' ? {} : { playerCode: code }),
      ...(noStyle ? { noStyle } : {}),
      ...(memoryOn ? { memory: { enabled: true, sourceGameIds: picked } } : {}),
      ...(scenarioStep && scenario ? { scenario } : {}),
    };
    setBusy(true);
    const result = await postCreateGame(apiBaseUrl, body);
    setBusy(false);
    if (result.ok) {
      dropDraft();
      return onCreated(result.member, result.token, result.game);
    }
    errors.setServer(result.fields);
    // Q-400: a memory refusal (409 not_allowed) is a message for the whole form.
    setFormError(result.form ?? (result.scenarioFields ? createGameText.scenarioRefused : undefined));
    if (result.scenarioFields) {
      setScenarioFields(result.scenarioFields);
      setScenarioOpen(true);
    }
  }

  function editScenario(next: Scenario) {
    // An added / removed row moves the paths the server's messages point at.
    if (listSizes(next) !== listSizes(scenario ?? defaultScenario())) setScenarioFields({});
    setScenario(next);
  }

  function useDefault() {
    if (!window.confirm(createGameText.defaultConfirm)) return;
    setScenario(undefined);
    setScenarioFields({});
  }

  function cancel() {
    dropDraft();
    onBack();
  }

  if (scenarioOpen) {
    return (
      <div className="pregame">
        <ScenarioEditor
          value={scenario ?? defaultScenario()}
          onChange={editScenario}
          fields={scenarioFields}
          error={Object.keys(scenarioFields).length > 0 ? createGameText.scenarioRefused : undefined}
          actions={
            <>
              <Button onClick={() => setScenarioOpen(false)}>{createGameText.scenarioDone}</Button> <Button onClick={useDefault}>{createGameText.scenarioDefault}</Button>
            </>
          }
        />
      </div>
    );
  }

  async function lookUpSources() {
    setLooking(true);
    setSourcesError(undefined);
    const result = await memorySourcesCall(apiBaseUrl, playerCode.trim());
    setLooking(false);
    if (result.kind === 'error') return setSourcesError(result.message);
    setSources(result.games);
    setPicked((ids) => ids.filter((id) => result.games.some((g) => g.id === id)));
    if (result.games.length === 0) setMemoryOn(false);
  }

  const bind = (field: TextField) => ({
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
      <Panel title="สร้างเกมใหม่" className="pregame__panel">
        <form onSubmit={submit} noValidate>
          <Button className="pregame__back" onClick={cancel}>
            {createGameText.cancel}
          </Button>
          <h2 className="pregame__title">สร้างเกมใหม่</h2>
          <Field
            id="create-createCode"
            label="Create code"
            hint="รหัสสร้างเกมของ server ขอจากคนดูแล server (ไม่ใช่โค้ดเกม)"
            error={errors.errorOf('createCode')}
          >
            {(control) => <input {...control} {...bind('createCode')} type="password" autoComplete="off" />}
          </Field>
          <Field id="create-gameName" label="ชื่อเกม" error={errors.errorOf('gameName')}>
            {(control) => <input {...control} {...bind('gameName')} autoComplete="off" />}
          </Field>
          <fieldset className="pregame__group">
            <legend>โหมด</legend>
            <label className="check">
              <input type="radio" name="mode" checked={values.mode === 'online'} onChange={() => setValues((v) => ({ ...v, mode: 'online' }))} />
              <span>Online 2-6 คน</span>
            </label>
            <label className="check">
              <input type="radio" name="mode" checked={values.mode === 'single'} onChange={() => setValues((v) => ({ ...v, mode: 'single' }))} />
              <span>เล่นคนเดียว (AI GM)</span>
            </label>
          </fieldset>
          {values.mode === 'online' && (
            <fieldset className="pregame__group">
              <legend>Game Master</legend>
              <p className="pregame__note">AI GM เล่าเรื่องและตัดสินผลเสมอ</p>
              <label className="check">
                <input type="checkbox" checked={values.humanGm} onChange={(e) => setValues((v) => ({ ...v, humanGm: e.target.checked }))} />
                <span>มี GM คน (คุณเป็น GM ไม่มีตัวละคร ไม่นับเป็นผู้เล่น)</span>
              </label>
              <p className="pregame__note">GM คนตรวจและอนุมัติผลทุกเทิร์นก่อนผู้เล่นเห็น</p>
              {errors.errorOf('humanGm') && (
                <p className="field-error" role="alert">
                  {errors.errorOf('humanGm')}
                </p>
              )}
            </fieldset>
          )}
          {scenarioStep && (
            <div className="lobby__row">
              <span>Scenario: {scenario ? createGameText.scenarioEdited : createGameText.scenarioStandard}</span>
              <Button onClick={() => setScenarioOpen(true)}>{createGameText.scenarioOpen}</Button>
              <small>{createGameText.scenarioNote}</small>
            </div>
          )}
          <NpcDialoguePicker value={values.npcDialogue ?? 'normal'} onChange={(npcDialogue) => setValues((v) => ({ ...v, npcDialogue }))} />
          <TonePicker value={values.tone} onChange={(tone) => setValues((v) => ({ ...v, tone }))} note={values.tone ? undefined : toneText.unset} />
          <Field id="create-name"label="ชื่อผู้เล่นของคุณ" hint="ใช้เข้าเกมนี้ครั้งหน้า คู่กับ PIN" error={errors.errorOf('name')}>
            {(control) => <input {...control} {...bind('name')} autoComplete="username" />}
          </Field>
          <Field id="create-pin" label="PIN ของคุณ" hint="ตัวเลข 4-6 หลัก" error={errors.errorOf('pin')}>
            {(control) => <PinInput {...control} {...bind('pin')} autoComplete="new-password" />}
          </Field>

          <section className="memory" aria-label="ความทรงจำจากเกมก่อน">
            <Field id="create-playerCode" label="รหัสผู้เล่นของคุณ (ไม่บังคับ)" hint="ผูกสไตล์การเล่นของคุณข้ามเกม และใช้หาเกมที่จบแล้วซึ่งคุณเคยเล่น">
              {(control) => (
                <input {...control} name="playerCode" value={playerCode} onChange={(e) => {
                    // Another code = another list: look it up again before the memory can be on.
                    setPlayerCode(e.target.value);
                    setSources(undefined);
                    setMemoryOn(false);
                  }} className="code-input" autoComplete="off" spellCheck={false} />
              )}
            </Field>
            <Button onClick={() => void lookUpSources()} disabled={playerCode.trim() === ''} loading={looking} loadingText="กำลังหาเกม…" disabledReason="ใส่รหัสผู้เล่นก่อน">
              ดูเกมที่ใช้ได้
            </Button>
            <label className="check">
              <input type="checkbox" checked={noStyle} onChange={(e) => setNoStyle(e.target.checked)} />
              <span>ไม่ต้องเก็บสไตล์ของฉัน</span>
            </label>
            {sourcesError && (
              <p className="field-error" role="alert">
                {sourcesError}
              </p>
            )}
            <div className="memory__head">
              <label className="switch">
                <input type="checkbox" role="switch" aria-label="ความทรงจำจากเกมก่อน" aria-describedby="memory-why" checked={memoryOn} disabled={noSources} onChange={(e) => setMemoryOn(e.target.checked)} />
                <span className="switch__track" aria-hidden="true" />
                <span className="switch__title">ความทรงจำจากเกมก่อน</span>
              </label>
              <span className="memory__state">{memoryOn ? 'เปิดอยู่' : 'ปิดอยู่'}</span>
            </div>
            <p className="pregame__note" id="memory-why">
              {sources === undefined
                ? 'ใส่รหัสผู้เล่นแล้วกด "ดูเกมที่ใช้ได้" ก่อน จึงจะเปิดได้'
                : sources.length === 0
                  ? 'ยังไม่มีเกมที่จบแล้วที่คุณเป็นสมาชิก จึงเปิดความทรงจำไม่ได้'
                  : `เมื่อเปิด AI GM จะรู้ตำนานโลก ข้อเสนอจากผู้เล่น การตัดสินที่ดี และสไตล์ของผู้เล่นในเกมนี้ จากเกมที่เลือก (ไม่เกิน ${MEMORY_MAX_SOURCES} เกม)`}
            </p>
            {memoryOn && sources && sources.length > 0 && (
              <>
                <fieldset className="pregame__group">
                  <legend>เลือกเกมที่จะให้ AI GM จำ</legend>
                  {sources.map((g) => (
                    <label className="check" key={g.id}>
                      <input
                        type="checkbox"
                        checked={picked.includes(g.id)}
                        disabled={!picked.includes(g.id) && picked.length >= MEMORY_MAX_SOURCES}
                        onChange={(e) => setPicked((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((id) => id !== g.id)))}
                      />
                      <span>
                        {g.name} <span className="memory__meta">{g.score === null ? 'ยังไม่มีคะแนน' : `คะแนน ${g.score}`} จบ {endedOn(g.endedAt)}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {memoryMissing && <p className="pregame__note">เลือกอย่างน้อย 1 เกม หรือปิดความทรงจำ จึงจะสร้างเกมได้</p>}
                <p className="pregame__note">ตั้งแล้วแก้ไม่ได้หลังเริ่มเกม</p>
              </>
            )}
          </section>

          {formError && (
            <p className="field-error pregame__form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="pregame__actions">
            <Button
              type="submit"
              variant="primary"
              disabled={blocked}
              loading={busy}
              loadingText="กำลังสร้างเกม…"
              disabledReason={errors.invalid ? 'ใส่ create code ชื่อเกม ชื่อผู้เล่น และ PIN ให้ครบก่อน' : 'เลือกเกมของความทรงจำก่อน'}
            >
              สร้างเกมและรับโค้ด
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
