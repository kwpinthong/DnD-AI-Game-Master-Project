import { eventTurnCount, PHASE_LABEL, PHASES as PERIODS, TURNS_PER_PERIOD, type Phase, type Scenario } from '@isekai/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { scenarioCall } from './scenario-api.ts';

type Event = Scenario['timeline'][number];
type Npc = Scenario['npcs'][number];
type Legendary = Scenario['legendaries'][number];
type Tab = 'events' | 'npcs' | 'legendaries';

/** GEN-063 / GEN-071 / GEN-096: an event runs from a turn of one of the 4 periods to a turn of an end period of the same day. */
const PHASES: { value: Phase; label: string }[] = PERIODS.map((value) => ({ value, label: PHASE_LABEL[value] }));
const phaseLabel = (p: Phase) => PHASE_LABEL[p];
const RANKS = ['F', 'B', 'A', 'S'] as const;

/** Ids the scenario schema accepts (a-z, 0-9, -). */
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const num = (raw: string) => (raw === '' ? Number.NaN : Number(raw));
const shown = (n: number) => (Number.isNaN(n) ? '' : n);

/**
 * ISK-019: the Human GM reads the game's scenario in the lobby; it was set at creation (POST /api/games) and nobody
 * edits it after (ISK-017).
 */
export function ScenarioViewer({
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
  const [scenario, setScenario] = useState<Scenario>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void scenarioCall(apiBaseUrl, token).then((result) => {
      if (cancelled) return;
      if (result.kind === 'session_lost') onSessionLost();
      else if (result.kind === 'error') setError(result.message);
      else setScenario(result.data.scenario);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, token]);
  const back = (
    <button type="button" onClick={onClose}>
      กลับห้องรอ
    </button>
  );
  if (!scenario) {
    return (
      <section aria-label="แก้ scenario">
        {back}
        {error ? <p role="alert">โหลด scenario ไม่ได้: {error}</p> : <p>กำลังโหลด scenario…</p>}
      </section>
    );
  }
  return (
    <ScenarioEditor value={scenario} locked lockedNote="ตั้ง scenario ตอนสร้างเกมแล้ว แก้ไม่ได้ (แทรกเหตุการณ์ระหว่างเล่นทำใน GM console)" actions={back} />
  );
}

/**
 * Scenario editor (GEN-046, GEN-044 wireframe 2b): the Human GM edits the game's copy (events, NPCs, secret
 * Legendaries). ISK-019: a step of the create-game form; the form sends the whole scenario in POST /api/games and the
 * server checks it (`fields`: its messages by path). `locked` = read-only. No styling yet (Q-073).
 */
export function ScenarioEditor({
  value: draft,
  onChange,
  fields = {},
  error,
  locked = false,
  lockedNote,
  actions,
}: {
  value: Scenario;
  onChange?: (scenario: Scenario) => void;
  fields?: Record<string, string>;
  error?: string | undefined;
  locked?: boolean;
  lockedNote?: string;
  /** The step's own buttons (back to the form, default, close). */
  actions?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('events');

  function edit(change: (s: Scenario) => Scenario) {
    onChange?.(change(draft));
  }

  const setAt = <K extends 'timeline' | 'npcs' | 'legendaries'>(key: K, i: number, patch: Partial<Scenario[K][number]>) =>
    edit((s) => ({ ...s, [key]: s[key].map((item, j) => (j === i ? { ...item, ...patch } : item)) }));
  const removeAt = (key: 'timeline' | 'npcs' | 'legendaries', i: number) =>
    edit((s) => ({ ...s, [key]: s[key].filter((_, j) => j !== i) }));

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

  /**
   * GEN-097: the event's places, any number of them, or the whole town (null). An empty list is sent as is
   * so the server's refusal names the field; errors of single places (`locationIds.1`) show here too.
   */
  const placesInput = (e: Event, i: number) => {
    const p = `timeline.${i}.locationIds`;
    const townWide = e.locationIds === null;
    const chosen = e.locationIds ?? [];
    const toggle = (id: string, on: boolean) =>
      setAt('timeline', i, { locationIds: on ? [...chosen, id] : chosen.filter((x) => x !== id) });
    const errors = Object.entries(fields).filter(([path]) => path === p || path.startsWith(`${p}.`));
    return (
      <fieldset>
        <legend>สถานที่</legend>
        <label>
          <input
            type="checkbox"
            checked={townWide}
            disabled={locked}
            onChange={(x) => setAt('timeline', i, { locationIds: x.target.checked ? null : [] })}
          />{' '}
          ทั้งเมือง
        </label>
        {draft!.locations.map((l) => (
          <label key={l.id}>
            {' '}
            <input
              type="checkbox"
              checked={chosen.includes(l.id)}
              disabled={locked || townWide}
              onChange={(x) => toggle(l.id, x.target.checked)}
            />{' '}
            {l.name}
          </label>
        ))}
        {errors.map(([path, message]) => (
          <small key={path} className="field-error">
            {' '}
            {message}
          </small>
        ))}
      </fieldset>
    );
  };

  const eventRow = (e: Event, i: number) => {
    const p = `timeline.${i}`;
    const kindNote = e.kind === 'finale' ? ' (ฉากจบ)' : e.kind === 'climax' ? ' (จุดไคลแมกซ์)' : '';
    // GEN-096: a turn shows only when it is not the whole period (start 2 / end 1).
    const startNote = e.startTurn !== 1 ? ` เทิร์น ${shown(e.startTurn)}` : '';
    const endNote = e.endTurn !== TURNS_PER_PERIOD ? ` เทิร์น ${shown(e.endTurn)}` : '';
    const range =
      e.endPhase && e.endPhase !== e.phase ? ` ถึง ${phaseLabel(e.endPhase) ?? e.endPhase}${endNote}` : endNote && ` ถึง${endNote}`;
    const turns = eventTurnCount(e);
    const hint = e.foreshadowAt;
    const setHint = (patch: Partial<NonNullable<Event['foreshadowAt']>>) =>
      setAt('timeline', i, { foreshadowAt: { day: hint?.day ?? e.day - 1, phase: hint?.phase ?? 'EOSORIA', ...patch } });
    return (
      <fieldset key={e.id}>
        <legend>
          เหตุการณ์ {i + 1}: วัน {shown(e.day)} {phaseLabel(e.phase) ?? e.phase}
          {startNote}
          {range} · {Number.isInteger(turns) && turns > 0 ? turns : '?'} เทิร์น
          {kindNote}
        </legend>
        {numberInput(`${e.id}-day`, 'วัน', `${p}.day`, e.day, (day) => setAt('timeline', i, { day }))}
        {select(`${e.id}-phase`, 'ช่วง', `${p}.phase`, e.phase, PHASES, (phase) => setAt('timeline', i, { phase }))}
        {select<Phase | ''>(`${e.id}-end`, 'ถึงช่วง', `${p}.endPhase`, e.endPhase ?? '', [{ value: '', label: 'ช่วงเดียว' }, ...PHASES], (end) =>
          setAt('timeline', i, { endPhase: end === '' ? null : end }),
        )}
        {/* GEN-096: number inputs, so a wrong turn reaches the server and comes back named by its field. */}
        {numberInput(`${e.id}-start-turn`, 'เริ่มเทิร์น', `${p}.startTurn`, e.startTurn, (n) => setAt('timeline', i, { startTurn: n as Event['startTurn'] }))}
        {numberInput(`${e.id}-end-turn`, 'จบเทิร์น', `${p}.endTurn`, e.endTurn, (n) => setAt('timeline', i, { endTurn: n as Event['endTurn'] }))}
        {textInput(`${e.id}-title`, 'หัวข้อ', `${p}.title`, e.title, (title) => setAt('timeline', i, { title }))}
        {textInput(`${e.id}-desc`, 'รายละเอียด', `${p}.description`, e.description, (description) => setAt('timeline', i, { description }), true)}
        {textInput(`${e.id}-effects`, 'ผลที่ผู้เล่นแทรกแซงได้', `${p}.interventionEffects`, e.interventionEffects, (interventionEffects) =>
          setAt('timeline', i, { interventionEffects }), true,
        )}
        {textInput(`${e.id}-outcome`, 'ผลถ้าไม่มีใครแทรกแซง', `${p}.outcome`, e.outcome, (outcome) => setAt('timeline', i, { outcome }), true)}
        {textInput(`${e.id}-hint`, 'ปูเรื่อง (ลางบอกเหตุ)', `${p}.foreshadowing`, e.foreshadowing, (foreshadowing) =>
          setAt('timeline', i, { foreshadowing }), true,
        )}
        {field(`${e.id}-hint-on`, 'มีวันปูเรื่อง', `${p}.foreshadowAt`, (id) => (
          <input
            id={id}
            type="checkbox"
            checked={hint !== null}
            disabled={locked}
            onChange={(x) => (x.target.checked ? setHint({}) : setAt('timeline', i, { foreshadowAt: null }))}
          />
        ))}
        {hint && numberInput(`${e.id}-hint-day`, 'ปูเรื่องวัน', `${p}.foreshadowAt.day`, hint.day, (day) => setHint({ day }))}
        {hint && select(`${e.id}-hint-phase`, 'ปูเรื่องช่วง', `${p}.foreshadowAt.phase`, hint.phase, PHASES, (phase) => setHint({ phase }))}
        {placesInput(e, i)}
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
          {
            id: newId('ev'),
            day: 1,
            phase: 'EOSORIA',
            endPhase: null,
            startTurn: 1,
            endTurn: 2,
            kind: 'event',
            title: '',
            description: '',
            outcome: '',
            interventionEffects: '',
            foreshadowing: '',
            foreshadowAt: null,
            strategyIds: [],
            crisis: false,
            locationIds: null,
            npcIds: [],
            gmNote: '',
          },
        ],
      }),
    );
  const addNpc = () =>
    edit(
      (s) => ({
        ...s,
        npcs: [
          ...s.npcs,
          { id: newId('npc'), name: '', alias: '', rank: 'F', locationId: s.locations[0]!.id, personality: '', obsTrait: 0, otherNames: [], gmNote: '' },
        ],
      }),
    );
  const addLegendary = () =>
    edit(
      (s) => ({
        ...s,
        legendaries: [...s.legendaries, { id: newId('leg'), name: '', type: 'item', condition: '', counter: 'count', target: 1, progress: 0, unlocked: false }],
      }),
    );

  return (
    <section aria-label="แก้ scenario">
      <p>
        {actions} แก้ scenario: <strong>{draft.name}</strong>
      </p>
      <p>เฉพาะ GM เห็นหน้านี้ ผู้เล่นไม่เห็นเนื้อหา scenario</p>
      {locked && lockedNote && <p>{lockedNote}</p>}
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
    </section>
  );
}
