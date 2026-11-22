import { PHASE_LABEL, PHASES as PERIODS, type Phase, type Scenario } from '@isekai/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { scenarioCall, type ScenarioAction } from './scenario-api.ts';

type Event = Scenario['timeline'][number];
type Npc = Scenario['npcs'][number];
type Legendary = Scenario['legendaries'][number];
type Tab = 'events' | 'npcs' | 'legendaries';

/** GEN-063: an event belongs to one of the 4 periods and lasts both of its turns. */
const PHASES: { value: Phase; label: string }[] = PERIODS.map((value) => ({ value, label: PHASE_LABEL[value] }));
const phaseLabel = (p: Phase) => PHASE_LABEL[p];
const RANKS = ['F', 'B', 'A', 'S'] as const;

/** Ids the scenario schema accepts (a-z, 0-9, -). */
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const num = (raw: string) => (raw === '' ? Number.NaN : Number(raw));
const shown = (n: number) => (Number.isNaN(n) ? '' : n);

/**
 * Scenario editor before the start (GEN-046, GEN-044 wireframe 2b): the Human GM edits this game's
 * copy (events, NPCs, secret Legendaries) and saves it whole; the server validates and sorts the
 * timeline. Read-only once the game has started. No styling yet (Q-073).
 */
export function ScenarioEditor({
  apiBaseUrl,
  token,
  onClose,
  onSessionLost,
}: {
  apiBaseUrl: string;
  token: string;
  onClose: () => void;
  onSessionLost: () => void;
}) {
  const [draft, setDraft] = useState<Scenario>();
  const [locked, setLocked] = useState(false);
  const [tab, setTab] = useState<Tab>('events');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(action: ScenarioAction) {
    setBusy(true);
    const result = await scenarioCall(apiBaseUrl, token, action);
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'invalid') {
      setFields(result.fields);
      setError('บันทึกไม่ได้ แก้ช่องที่บอกไว้ก่อน');
      return;
    }
    if (result.kind === 'error') return setError(result.message);
    setDraft(result.data.scenario);
    setLocked(result.data.locked);
    setFields({});
    setError(undefined);
    setSaved(action.kind !== 'load');
  }

  useEffect(() => {
    void run({ kind: 'load' });
    // Loaded once per token.
  }, [apiBaseUrl, token]);

  function edit(change: (s: Scenario) => Scenario, structural = false) {
    setDraft((s) => (s ? change(s) : s));
    setSaved(false);
    if (structural) setFields({});
  }

  const setAt = <K extends 'timeline' | 'npcs' | 'legendaries'>(key: K, i: number, patch: Partial<Scenario[K][number]>) =>
    edit((s) => ({ ...s, [key]: s[key].map((item, j) => (j === i ? { ...item, ...patch } : item)) }));
  const removeAt = (key: 'timeline' | 'npcs' | 'legendaries', i: number) =>
    edit((s) => ({ ...s, [key]: s[key].filter((_, j) => j !== i) }), true);

  const fieldError = (path: string) => (fields[path] ? <small className="field-error"> {fields[path]}</small> : null);

  /** One labelled control; `path` is the server's field path for its error message. */
  function field(id: string, label: string, path: string, control: (id: string) => ReactNode) {
    return (
      <div>
        <label htmlFor={id}>{label}</label> {control(id)}
        {fieldError(path)}
      </div>
    );
  }
  const textInput = (id: string, label: string, path: string, value: string, onChange: (v: string) => void, long = false) =>
    field(id, label, path, (htmlId) =>
      long ? (
        <textarea id={htmlId} value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={htmlId} value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} />
      ),
    );
  const numberInput = (id: string, label: string, path: string, value: number, onChange: (v: number) => void) =>
    field(id, label, path, (htmlId) => (
      <input id={htmlId} type="number" value={shown(value)} disabled={locked} onChange={(e) => onChange(num(e.target.value))} />
    ));
  function select<T extends string>(
    id: string,
    label: string,
    path: string,
    value: T,
    options: readonly { value: T; label: string }[],
    onChange: (v: T) => void,
  ) {
    return field(id, label, path, (htmlId) => (
      <select id={htmlId} value={value} disabled={locked} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ));
  }

  if (!draft) {
    return (
      <section aria-label="แก้ scenario">
        <button type="button" onClick={onClose}>
          กลับห้องรอ
        </button>
        {error ? <p role="alert">โหลด scenario ไม่ได้: {error}</p> : <p>กำลังโหลด scenario…</p>}
      </section>
    );
  }

  const eventRow = (e: Event, i: number) => {
    const p = `timeline.${i}`;
    const kindNote = e.kind === 'finale' ? ' (ฉากจบ)' : e.kind === 'climax' ? ' (จุดไคลแมกซ์)' : '';
    return (
      <fieldset key={e.id}>
        <legend>
          เหตุการณ์ {i + 1}: วัน {shown(e.day)} {phaseLabel(e.phase) ?? e.phase}
          {kindNote}
        </legend>
        {numberInput(`${e.id}-day`, 'วัน', `${p}.day`, e.day, (day) => setAt('timeline', i, { day }))}
        {select(`${e.id}-phase`, 'ช่วง', `${p}.phase`, e.phase, PHASES, (phase) => setAt('timeline', i, { phase }))}
        {textInput(`${e.id}-title`, 'หัวข้อ', `${p}.title`, e.title, (title) => setAt('timeline', i, { title }))}
        {textInput(`${e.id}-desc`, 'รายละเอียด', `${p}.description`, e.description, (description) => setAt('timeline', i, { description }), true)}
        {textInput(`${e.id}-outcome`, 'ผลตั้งต้น', `${p}.outcome`, e.outcome, (outcome) => setAt('timeline', i, { outcome }), true)}
        {field(`${e.id}-crisis`, 'วิกฤต (NPC เกรด A ขึ้น S ได้)', `${p}.crisis`, (id) => (
          <input id={id} type="checkbox" checked={e.crisis} disabled={locked} onChange={(x) => setAt('timeline', i, { crisis: x.target.checked })} />
        ))}
        {textInput(`${e.id}-gm`, 'โน้ตลับของ GM', `${p}.gmNote`, e.gmNote, (gmNote) => setAt('timeline', i, { gmNote }), true)}
        {fieldError(`${p}.kind`)}
        {e.kind === 'finale' ? (
          <p>ฉากจบวันที่ 12 ลบไม่ได้</p>
        ) : (
          !locked && (
            <button type="button" aria-label={`ลบเหตุการณ์ ${e.title || i + 1}`} onClick={() => removeAt('timeline', i)}>
              ลบ
            </button>
          )
        )}
      </fieldset>
    );
  };

  const locations = draft.locations.map((l) => ({ value: l.id, label: l.name }));
  const npcRow = (n: Npc, i: number) => {
    const p = `npcs.${i}`;
    return (
      <fieldset key={n.id}>
        <legend>
          NPC {i + 1}: {n.alias || n.name}
        </legend>
        {textInput(`${n.id}-name`, 'ชื่อจริง', `${p}.name`, n.name, (name) => setAt('npcs', i, { name }))}
        {textInput(`${n.id}-alias`, 'คำเรียกก่อนรู้ชื่อ', `${p}.alias`, n.alias, (alias) => setAt('npcs', i, { alias }))}
        {select(`${n.id}-rank`, 'เกรด', `${p}.rank`, n.rank, RANKS.map((r) => ({ value: r, label: r })), (rank) => setAt('npcs', i, { rank }))}
        {select(`${n.id}-loc`, 'สถานที่', `${p}.locationId`, n.locationId, locations, (locationId) => setAt('npcs', i, { locationId }))}
        {textInput(`${n.id}-pers`, 'นิสัย', `${p}.personality`, n.personality, (personality) => setAt('npcs', i, { personality }), true)}
        {textInput(`${n.id}-gm`, 'โน้ตลับของ GM', `${p}.gmNote`, n.gmNote, (gmNote) => setAt('npcs', i, { gmNote }), true)}
        {!locked && (
          <button type="button" aria-label={`ลบ NPC ${n.alias || i + 1}`} onClick={() => removeAt('npcs', i)}>
            ลบ
          </button>
        )}
      </fieldset>
    );
  };

  const legendaryRow = (l: Legendary, i: number) => {
    const p = `legendaries.${i}`;
    return (
      <fieldset key={l.id}>
        <legend>
          ตำนาน {i + 1}: {l.name}
        </legend>
        {textInput(`${l.id}-name`, 'ชื่อ', `${p}.name`, l.name, (name) => setAt('legendaries', i, { name }))}
        {select(`${l.id}-type`, 'ประเภท', `${p}.type`, l.type, [{ value: 'skill', label: 'สกิล' }, { value: 'item', label: 'ไอเทม' }] as const, (type) =>
          setAt('legendaries', i, { type }),
        )}
        {textInput(`${l.id}-cond`, 'เงื่อนไขลับ', `${p}.condition`, l.condition, (condition) => setAt('legendaries', i, { condition }), true)}
        {select(
          `${l.id}-counter`,
          'นับแบบ',
          `${p}.counter`,
          l.counter,
          [{ value: 'streak_days', label: 'ทำติดกันกี่วัน' }, { value: 'count', label: 'นับจำนวนครั้ง' }] as const,
          (counter) => setAt('legendaries', i, { counter }),
        )}
        {numberInput(`${l.id}-target`, 'เป้า', `${p}.target`, l.target, (target) => setAt('legendaries', i, { target }))}
        {!locked && (
          <button type="button" aria-label={`ลบตำนาน ${l.name || i + 1}`} onClick={() => removeAt('legendaries', i)}>
            ลบ
          </button>
        )}
      </fieldset>
    );
  };

  const addEvent = () =>
    edit(
      (s) => ({
        ...s,
        timeline: [
          ...s.timeline,
          { id: newId('ev'), day: 1, phase: 'EOSORIA', kind: 'event', title: '', description: '', outcome: '', crisis: false, locationId: null, npcIds: [], gmNote: '' },
        ],
      }),
      true,
    );
  const addNpc = () =>
    edit(
      (s) => ({
        ...s,
        npcs: [...s.npcs, { id: newId('npc'), name: '', alias: '', rank: 'F', locationId: s.locations[0]!.id, personality: '', obsTrait: 0, gmNote: '' }],
      }),
      true,
    );
  const addLegendary = () =>
    edit(
      (s) => ({
        ...s,
        legendaries: [...s.legendaries, { id: newId('leg'), name: '', type: 'item', condition: '', counter: 'count', target: 1, progress: 0, unlocked: false }],
      }),
      true,
    );

  function reset() {
    if (!window.confirm('คืนค่า scenario ทั้งหมดเป็นค่าตั้งต้น? สิ่งที่แก้ไว้จะหายหมด')) return;
    void run({ kind: 'reset' });
  }

  return (
    <section aria-label="แก้ scenario">
      <p>
        <button type="button" onClick={onClose}>
          กลับห้องรอ
        </button>{' '}
        แก้ scenario: <strong>{draft.name}</strong> {saved && <span role="status">บันทึกแล้ว</span>}
      </p>
      <p>เฉพาะ GM เห็นหน้านี้ ผู้เล่นไม่เห็นเนื้อหา scenario</p>
      {locked && <p>เกมเริ่มแล้ว scenario ล็อก แก้ไม่ได้ (แทรกเหตุการณ์ระหว่างเล่นทำใน GM console)</p>}
      <nav>
        <button type="button" aria-pressed={tab === 'events'} onClick={() => setTab('events')}>
          เหตุการณ์ 12 วัน
        </button>{' '}
        <button type="button" aria-pressed={tab === 'npcs'} onClick={() => setTab('npcs')}>
          NPC
        </button>{' '}
        <button type="button" aria-pressed={tab === 'legendaries'} onClick={() => setTab('legendaries')}>
          ตำนานลับ
        </button>
      </nav>
      {error && (
        <div role="alert">
          <p>{error}</p>
          {Object.keys(fields).length > 0 && (
            <ul>
              {Object.entries(fields).map(([path, message]) => (
                <li key={path}>
                  {path}: {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {tab === 'events' && (
        <div>
          {fieldError('timeline')}
          {draft.timeline.map(eventRow)}
          {!locked && (
            <button type="button" onClick={addEvent}>
              เพิ่มเหตุการณ์
            </button>
          )}
        </div>
      )}
      {tab === 'npcs' && (
        <div>
          {fieldError('npcs')}
          {draft.npcs.map(npcRow)}
          {!locked && (
            <button type="button" onClick={addNpc}>
              เพิ่ม NPC
            </button>
          )}
        </div>
      )}
      {tab === 'legendaries' && (
        <div>
          <p>ผู้เล่นไม่เห็นแท็บนี้ และไม่รู้เงื่อนไขจนกว่าจะปลดล็อก</p>
          {fieldError('legendaries')}
          {draft.legendaries.map(legendaryRow)}
          {!locked && (
            <button type="button" onClick={addLegendary}>
              เพิ่มตำนานลับ
            </button>
          )}
        </div>
      )}
      {!locked && (
        <p>
          <button type="button" disabled={busy} onClick={() => void run({ kind: 'save', scenario: draft })}>
            บันทึก
          </button>{' '}
          <button type="button" disabled={busy} onClick={reset}>
            คืนค่า default
          </button>
        </p>
      )}
    </section>
  );
}
