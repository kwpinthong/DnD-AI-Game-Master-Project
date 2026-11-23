import { createGameFieldErrors, type CreateGameField, type GameView, type Member, type MemorySourceGame } from '@isekai/protocol';
import { useState, type FormEvent } from 'react';
import { useFieldErrors } from './form-state.ts';
import { memorySourcesCall, postCreateGame, type CreateGameInput } from './game-api.ts';
import { NpcDialoguePicker } from './NpcDialoguePicker.tsx';
import { PENDING_BACKEND_UI } from './pending.ts';
import { PinInput } from './PinInput.tsx';
import { Button, EmptyState, Field, Panel } from './ui/index.ts';
import './pregame.css';

type TextField = 'createCode' | 'gameName' | 'name' | 'pin';
type Base = Omit<CreateGameInput, 'playerCode' | 'memory'>;

const endedOn = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });

/**
 * Create game v2 (GEN-090, Screens and Flows v2 §2): create code, game name, mode, Human GM and the
 * creator's own login. A field says what is wrong once the creator leaves it; the create button stays off
 * until everything passes (C2). `pendingFields` adds "ความทรงจำจากเกมก่อน" (GEN-083, `GameMemorySetting`,
 * off by default) with the source games found by the creator's player code (Q-225); the server does not
 * read it yet, so it is on only in mock mode until GEN-102.
 */
export function CreateGameForm({
  apiBaseUrl,
  onCreated,
  onBack,
  pendingFields = PENDING_BACKEND_UI,
}: {
  apiBaseUrl: string;
  onCreated: (member: Member, token: string, game: GameView) => void;
  onBack: () => void;
  pendingFields?: boolean;
}) {
  const [values, setValues] = useState<Base>({ createCode: '', gameName: '', mode: 'online', humanGm: false, npcDialogue: 'normal', name: '', pin: '' });
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [memoryOn, setMemoryOn] = useState(false);
  const [playerCode, setPlayerCode] = useState('');
  /** undefined = not looked up yet. */
  const [sources, setSources] = useState<MemorySourceGame[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [sourcesError, setSourcesError] = useState<string>();
  const [looking, setLooking] = useState(false);

  // Single is AI GM only, so the Human GM choice is dropped with it.
  const base: Base = { ...values, humanGm: values.mode === 'online' && values.humanGm };
  const errors = useFieldErrors<CreateGameField>(createGameFieldErrors(base));
  const memoryMissing = pendingFields && memoryOn && picked.length === 0;
  const blocked = errors.invalid || memoryMissing;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    if (blocked) return errors.touchAll();
    if (busy) return;

    const body: CreateGameInput = pendingFields
      ? { ...base, playerCode: playerCode.trim(), memory: { enabled: memoryOn, sourceGameIds: memoryOn ? picked : [] } }
      : base;
    setBusy(true);
    const result = await postCreateGame(apiBaseUrl, body);
    setBusy(false);
    if (result.ok) return onCreated(result.member, result.token, result.game);
    errors.setServer(result.fields);
    setFormError(result.form);
  }

  async function lookUpSources() {
    setLooking(true);
    setSourcesError(undefined);
    const result = await memorySourcesCall(apiBaseUrl, playerCode.trim());
    setLooking(false);
    if (result.kind === 'error') return setSourcesError(result.message);
    setSources(result.games);
    setPicked((ids) => ids.filter((id) => result.games.some((g) => g.id === id)));
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
          <Button className="pregame__back" onClick={onBack}>
            &lt; กลับ
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
          <NpcDialoguePicker value={values.npcDialogue ?? 'normal'} onChange={(npcDialogue) => setValues((v) => ({ ...v, npcDialogue }))} />
          <Field id="create-name"label="ชื่อผู้เล่นของคุณ" hint="ใช้เข้าเกมนี้ครั้งหน้า คู่กับ PIN" error={errors.errorOf('name')}>
            {(control) => <input {...control} {...bind('name')} autoComplete="username" />}
          </Field>
          <Field id="create-pin" label="PIN ของคุณ" hint="ตัวเลข 4-6 หลัก" error={errors.errorOf('pin')}>
            {(control) => <PinInput {...control} {...bind('pin')} autoComplete="new-password" />}
          </Field>

          {pendingFields && (
            <section className="memory" aria-label="ความทรงจำจากเกมก่อน">
              <div className="memory__head">
                <label className="switch">
                  <input type="checkbox" role="switch" aria-label="ความทรงจำจากเกมก่อน" checked={memoryOn} onChange={(e) => setMemoryOn(e.target.checked)} />
                  <span className="switch__track" aria-hidden="true" />
                  <span className="switch__title">ความทรงจำจากเกมก่อน</span>
                </label>
                <span className="memory__state">{memoryOn ? 'เปิดอยู่' : 'ปิดอยู่'}</span>
              </div>
              <p className="pregame__note">
                เมื่อเปิด AI GM จะรู้ตำนานโลก ข้อเสนอจากผู้เล่น การตัดสินที่ดี และสไตล์ของผู้เล่นในเกมนี้ จากเกมที่เลือก
              </p>
              {memoryOn && (
                <>
                  <Field id="create-playerCode" label="รหัสผู้เล่นของคุณ" hint="ใช้หาเกมที่จบแล้วซึ่งคุณเคยเล่นและผ่านเกณฑ์คะแนน">
                    {(control) => (
                      <input {...control} name="playerCode" value={playerCode} onChange={(e) => setPlayerCode(e.target.value)} className="code-input" autoComplete="off" spellCheck={false} />
                    )}
                  </Field>
                  <Button onClick={() => void lookUpSources()} disabled={playerCode.trim() === ''} loading={looking} loadingText="กำลังหาเกม…" disabledReason="ใส่รหัสผู้เล่นก่อน">
                    ดูเกมที่ใช้ได้
                  </Button>
                  {sourcesError && (
                    <p className="field-error" role="alert">
                      {sourcesError}
                    </p>
                  )}
                  {sources && sources.length === 0 && <EmptyState title="ยังไม่มีเกมที่ผ่านเกณฑ์">ต้องเป็นเกมที่จบแล้ว คะแนนเฉลี่ยมากกว่า 8 และคุณเป็นสมาชิก</EmptyState>}
                  {sources && sources.length > 0 && (
                    <fieldset className="pregame__group">
                      <legend>เลือกเกมที่จะให้ AI GM จำ</legend>
                      {sources.map((g) => (
                        <label className="check" key={g.id}>
                          <input
                            type="checkbox"
                            checked={picked.includes(g.id)}
                            onChange={(e) => setPicked((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((id) => id !== g.id)))}
                          />
                          <span>
                            {g.name} <span className="memory__meta">คะแนน {g.score} จบ {endedOn(g.endedAt)}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {memoryMissing && <p className="pregame__note">เลือกอย่างน้อย 1 เกม หรือปิดความทรงจำ จึงจะสร้างเกมได้</p>}
                  <p className="pregame__note">ตั้งแล้วแก้ไม่ได้หลังเริ่มเกม</p>
                </>
              )}
            </section>
          )}

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
