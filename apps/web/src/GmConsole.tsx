import {
  PHASES,
  PHASE_LABEL,
  type GmAdjustRequest,
  type GmCheckView,
  type GmConsoleResponse,
  type GmCurseView,
  type GmFallbackCause,
  type GmInsertEventRequest,
  type GmOverrideView,
  type GmPendingTurn,
  type GmStats,
  type GmVotesResponse,
  type Phase,
  type RoomGmStatus,
  type RoomPhaseStatus,
} from '@isekai/protocol';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { gmConsoleApi } from './gm-console-api.ts';
import { Button } from './ui/Button.tsx';
import { ErrorState, Skeleton, VisibilityBadge } from './ui/parts.tsx';
import { gmText, playText } from './ui/strings.ts';
import './gm-console.css';
import './pregame.css';

const STATS: readonly (keyof GmStats)[] = ['hp', 'stamina', 'karma'];
const STAT_LABEL: Record<keyof GmStats, string> = { hp: 'HP', stamina: 'Stamina', karma: 'Karma' };
const EVENT_STATUS = { pending: 'ยังไม่เกิด', active: 'กำลังเกิด', resolved: 'จบแล้ว' } as const;
const ROOM_STATUS: Record<RoomPhaseStatus, string> = { collecting: 'เปิดรับ action', resolving: 'ปิดรับแล้ว กำลังสรุปผล', finale: 'ฉากจบ', game_over: 'เกมจบแล้ว' };

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const curseText = (c: GmCurseView) => gmText.curse(c.label, c.source, c.value, c.turnsLeft);

function Panel({ label, title = label, className, children }: { label: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={['gm-panel', className].filter(Boolean).join(' ')}>
      <h3 className="gm-panel__title">{title}</h3>
      {children}
    </section>
  );
}

/** One roll of the held turn with every number (the GM is the only one who gets them). */
function Check({ check: c, who }: { check: GmCheckView; who: string }) {
  const mod = c.modifiers.reduce((sum, m) => sum + m.value, 0);
  return (
    <li className="gm-check" aria-label={`${who}: ${c.text}`}>
      <p className="gm-check__what">
        <strong>{who}</strong>
        <VisibilityBadge visibility={c.visibility} />
        <span>{c.text}</span>
      </p>
      <p className="gm-check__roll">
        {c.tags.length > 0 && <span className="gm-check__tags">{c.tags.join(' / ')}</span>}
        <span className="gm-num">DC {c.dc}</span>
        <span>
          mod {signed(mod)}
          {c.modifiers.length > 0 && <small> ({c.modifiers.map((m) => `${m.label} ${signed(m.value)}`).join(', ')})</small>}
        </span>
        <span className="gm-num">d20 {c.d20}</span>
        <span className="gm-num">รวม {c.total}</span>
        <span className={`gm-check__outcome gm-check__outcome--${c.outcome.includes('success') ? 'ok' : 'bad'}`}>{playText.outcome[c.outcome]}</span>
      </p>
    </li>
  );
}

/** Q-243: the side of an event outcome, GM only (the sheet's own words). */
const OUTCOME_SIDE = { good: 'Good', evil: 'Evil', neutral: 'Neutral' } as const;

/** The held turn: narration texts and HP / Stamina / Karma per player, edited with one reason, then approved. */
function HeldTurn({
  pending,
  nameOf,
  onSave,
  onApprove,
}: {
  pending: GmPendingTurn;
  nameOf: (memberId: string | null) => string;
  onSave: (body: { reason: string; narrations: { index: number; text: string }[]; results: ({ memberId: string } & Partial<GmStats>)[] }) => Promise<string | null>;
  onApprove: () => Promise<string | null>;
}) {
  // The caller keys this by the held turn, so a reload with new values starts the drafts again.
  const [texts, setTexts] = useState<Record<number, string>>(() => Object.fromEntries(pending.entries.map((e) => [e.index, e.text])));
  const [stats, setStats] = useState<Record<string, Partial<Record<keyof GmStats, string>>>>(() =>
    Object.fromEntries(pending.results.map((r) => [r.memberId, Object.fromEntries(STATS.map((s) => [s, String(r.after[s])]))])),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Q-215: the held finale is told apart from an ordinary turn by its own label; only narration can change.
  const finale = pending.finale === true;
  // GEN-186: the held period scene is text only, like the finale.
  const scene = pending.scene === true;
  // GEN-128: the held NPC lines of a published turn are text only too.
  const dialogue = pending.dialogue === true;
  const label = finale ? gmText.heldFinale : scene ? gmText.heldScene : dialogue ? gmText.heldDialogue : gmText.heldTurn;

  async function save(event: FormEvent) {
    event.preventDefault();
    const narrations = pending.entries.flatMap((e) => (texts[e.index] !== undefined && texts[e.index] !== e.text ? [{ index: e.index, text: texts[e.index]! }] : []));
    const results = pending.results.flatMap((r) => {
      const changed = Object.fromEntries(STATS.flatMap((s) => (stats[r.memberId]?.[s] !== undefined && Number(stats[r.memberId]![s]) !== r.after[s] ? [[s, Number(stats[r.memberId]![s])]] : [])));
      return Object.keys(changed).length > 0 ? [{ memberId: r.memberId, ...changed }] : [];
    });
    setError(await onSave({ reason, narrations, results }));
  }

  return (
    <section aria-label={label} className={finale ? 'gm-panel gm-held gm-held--finale' : 'gm-panel gm-held'}>
      <h3 className="gm-panel__title gm-held__title">
        {label}: วันที่ {pending.at.day} · {PHASE_LABEL[pending.at.phase]} · เทิร์น {pending.at.turn}/2
      </h3>
      <p className="gm-held__note">{finale ? gmText.finaleNote : scene ? gmText.sceneNote : dialogue ? gmText.dialogueNote : gmText.heldNote}</p>
      {scene || dialogue ? null : pending.checks ? (
        <ol className="gm-checks" aria-label={gmText.checks}>
          {pending.checks.map((c, i) => (
            <Check key={i} check={c} who={nameOf(c.memberId)} />
          ))}
        </ol>
      ) : (
        !finale && <p className="gm-pending">{gmText.checksPending}</p>
      )}
      <form onSubmit={save} className="gm-form">
        {pending.entries.map((e) => (
          <label key={e.index}>
            ข้อความ {e.index + 1} ({e.kind === 'narration' ? `ถึง ${nameOf(e.memberId)} คนเดียว` : `ฟีดของ ${e.locationId ?? 'ทั้งเมือง'}`})
            {e.edited ? ' · แก้แล้ว' : ''}
            <textarea rows={4} value={texts[e.index] ?? ''} onChange={(ev) => setTexts({ ...texts, [e.index]: ev.target.value })} />
          </label>
        ))}
        {!finale &&
          pending.results.map((r) => (
            <fieldset key={r.memberId} className="gm-result">
              <legend>
                {nameOf(r.memberId)} (ก่อนเทิร์น HP {r.before.hp} · Stamina {r.before.stamina} · Karma {r.before.karma}){r.edited ? ' · แก้แล้ว' : ''}
              </legend>
              {STATS.map((s) => (
                <label key={s}>
                  {`${STAT_LABEL[s]} ของ ${nameOf(r.memberId)}`}
                  <input
                    type="number"
                    value={stats[r.memberId]?.[s] ?? ''}
                    onChange={(ev) => setStats({ ...stats, [r.memberId]: { ...stats[r.memberId], [s]: ev.target.value } })}
                  />
                </label>
              ))}
            </fieldset>
          ))}
        <label>
          เหตุผลของการแก้
          <input value={reason} onChange={(ev) => setReason(ev.target.value)} />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="gm-form__actions">
          <Button type="submit">บันทึกการแก้</Button>
          <Button variant="primary" onClick={async () => setError(await onApprove())}>
            อนุมัติและส่งให้ผู้เล่น
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Q-177: why a narration is the server template. */
const FALLBACK_CAUSE: Record<GmFallbackCause, string> = {
  timeout: 'AI ไม่ตอบ (timeout) ลองซ้ำ 1 ครั้งแล้ว',
  budget: 'ใช้ครบงบ AI ของเดือนแล้ว',
  invalid: 'ข้อความของ AI ยังผิดหลังให้แก้ 1 ครั้ง',
  error: 'เรียก AI ไม่สำเร็จ',
};

/** Q-174: a hand edit changes the number only; the companion rules run on the next normal change. */
const AFFINITY_HAND_EDIT_NOTE =
  'ตั้งค่าด้วยมือจะไม่เปิดเผยชื่อ NPC ไม่ให้รางวัล +9 และไม่วิวัฒนาการทันที กฎจะทำงานตอนค่าความสัมพันธ์เปลี่ยนตามปกติครั้งถัดไป';

function AdjustForm({ view, onAdjust }: { view: GmConsoleResponse; onAdjust: (body: GmAdjustRequest) => Promise<string | null> }) {
  const [memberId, setMemberId] = useState('');
  const [field, setField] = useState<GmAdjustRequest['field']>('hp');
  const [npcId, setNpcId] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const common = { memberId, value: Number(value), reason };
    setError(await onAdjust(field === 'affinity' ? { field, npcId, ...common } : { field, ...common }));
  }
  return (
    <form aria-label="ปรับค่าด้วยมือ" onSubmit={submit} className="gm-panel gm-form">
      <h3 className="gm-panel__title">ปรับค่าด้วยมือ (ระหว่างเทิร์น ในกรอบของกฎ)</h3>
      <div className="gm-form__row">
        <label>
          ตัวละคร
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">เลือก</option>
            {view.characters.map((c) => (
              <option key={c.memberId} value={c.memberId}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          ค่า
          <select value={field} onChange={(e) => setField(e.target.value as GmAdjustRequest['field'])}>
            <option value="hp">HP</option>
            <option value="stamina">Stamina</option>
            <option value="karma">Karma</option>
            <option value="affinity">ค่าความสัมพันธ์กับ NPC</option>
          </select>
        </label>
        <label>
          ค่าใหม่
          <input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      </div>
      {field === 'affinity' && (
        <>
          <label>
            NPC id
            <input value={npcId} onChange={(e) => setNpcId(e.target.value)} />
          </label>
          <p role="note" className="gm-form__note">
            {AFFINITY_HAND_EDIT_NOTE}
          </p>
        </>
      )}
      <label>
        เหตุผล
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="gm-form__actions">
        <Button type="submit">ปรับค่า</Button>
      </div>
    </form>
  );
}

function EventForm({ onInsert }: { onInsert: (body: GmInsertEventRequest) => Promise<string | null> }) {
  const [day, setDay] = useState('');
  const [phase, setPhase] = useState<Phase>('EOSORIA');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(await onInsert({ day: Number(day), phase, title, description, locationId: locationId.trim() === '' ? null : locationId.trim(), reason }));
  }
  return (
    <form aria-label="แทรกเหตุการณ์" onSubmit={submit} className="gm-panel gm-form">
      <h3 className="gm-panel__title">แทรกเหตุการณ์ (ช่วงปัจจุบันหรือภายหลัง)</h3>
      <div className="gm-form__row">
        <label>
          วันที่
          <input type="number" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label>
          ช่วงเวลา
          <select value={phase} onChange={(e) => setPhase(e.target.value as Phase)}>
            {PHASES.map((p) => (
              <option key={p} value={p}>
                {PHASE_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        ชื่อเหตุการณ์
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        รายละเอียด
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        สถานที่ (id เว้นว่าง = ทั้งเมือง)
        <input value={locationId} onChange={(e) => setLocationId(e.target.value)} />
      </label>
      <label>
        เหตุผล
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="gm-form__actions">
        <Button type="submit">แทรกเหตุการณ์</Button>
      </div>
    </form>
  );
}

/** Q-176: how many edits an `approve` row published. */
function approvedEdits(o: GmOverrideView): number {
  const edits = (o.after as { edits?: unknown } | null)?.edits;
  return typeof edits === 'number' ? edits : 0;
}

const overrideLine = (o: GmOverrideView) => {
  const at = `วันที่ ${o.at.day} · ${o.at.phase} · เทิร์น ${o.at.turn} · ${o.gmName}`;
  if (o.kind === 'approve') {
    const edits = approvedEdits(o);
    return `${at} · ${edits === 0 ? 'อนุมัติผลของเทิร์นตามที่ AI GM เขียน' : `อนุมัติผลของเทิร์น (แก้ ${edits} จุด)`}`;
  }
  return `${at} · ${o.kind} · ${o.target} · ${JSON.stringify(o.before)} → ${JSON.stringify(o.after)} · เหตุผล: ${o.reason}`;
};

interface NpcRow {
  id: string;
  name: string;
  bonds: { who: string; affinity: number; nameRevealed: boolean }[];
  curses: readonly GmCurseView[];
}

/** Every NPC a character has an affinity with, plus (Q-252, pending backend) the NPCs that carry a curse. */
function npcRows(view: GmConsoleResponse): NpcRow[] {
  const rows = new Map<string, NpcRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, name: id, bonds: [], curses: [] }));
    return r;
  };
  for (const c of view.characters) for (const b of c.npcBonds) row(b.npcId).bonds.push({ who: c.name, affinity: b.affinity, nameRevealed: b.nameRevealed });
  for (const n of view.npcs ?? []) Object.assign(row(n.npcId), { name: n.name, curses: n.curses });
  return [...rows.values()];
}

/**
 * The Human GM console (GEN-058; layout GEN-091, Screens and Flows v2 §5): three columns on a desktop — the
 * characters and NPCs with every number a player never gets (Karma, the Reputation number, affinity), the
 * turn that waits for approval with its rolls (DC, modifiers) and the hand edits, and the world (timeline,
 * Legendary conditions, evidence, the logs). Reloads whenever `refreshKey` changes (the room tells it the
 * turn moved). `gmStatus` is the room's AI GM status (Q-221: `budget_reached`).
 */
export function GmConsole({ apiBaseUrl, token, refreshKey, gmStatus }: { apiBaseUrl: string; token: string; refreshKey: string; gmStatus?: RoomGmStatus | null }) {
  const api = useMemo(() => gmConsoleApi(apiBaseUrl, token), [apiBaseUrl, token]);
  const [view, setView] = useState<GmConsoleResponse | null>(null);
  const [log, setLog] = useState<GmOverrideView[]>([]);
  const [votes, setVotes] = useState<GmVotesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [v, l, votes] = await Promise.all([api.view(), api.log(), api.votes()]);
    if (v.ok) setView(v.value);
    if (l.ok) setLog(l.value.overrides);
    if (votes.ok) setVotes(votes.value);
    setError(v.ok ? null : v.message);
  }, [api]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /** Runs a change; on success reloads and returns null, otherwise the Thai reason. */
  const run = async (call: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    const result = await call();
    if (!result.ok) return result.message;
    await load();
    return null;
  };

  if (!view) {
    return (
      <section aria-label="GM console" className="gm">
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : <Skeleton lines={4} label="กำลังโหลด GM console…" />}
      </section>
    );
  }
  const nameOf = (memberId: string | null) => view.characters.find((c) => c.memberId === memberId)?.name ?? 'ไม่ทราบชื่อ';
  const npcs = npcRows(view);
  const playerBonds = view.characters.flatMap((c) => c.playerBonds.map((b) => ({ from: c.name, to: nameOf(b.memberId), ...b })));

  return (
    <section aria-label="GM console" className="gm">
      <p role="note" aria-label="คำแนะนำสำหรับมือถือ" className="gm__phone-note">
        {gmText.phoneNote}
      </p>
      <header className="gm__bar">
        <h2 className="gm__title">GM console</h2>
        <p className="gm__when">
          วันที่ {view.at.day} · <span className="latin-caps">{view.at.phase}</span> · เทิร์น {view.at.turn}/2
        </p>
        <p className="gm__room">{ROOM_STATUS[view.status]}</p>
        {/* GEN-198: on = the NPC lines go out without a second approval; the turn result still waits here. */}
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="อนุมัติบทพูดอัตโนมัติ"
            checked={view.autoApproveLines === true}
            onChange={(e) => void run(() => api.saveSettings({ autoApproveLines: e.target.checked })).then((message) => message && setError(message))}
          />
          <span className="switch__track" aria-hidden="true" />
          <span>อนุมัติบทพูดอัตโนมัติ</span>
        </label>
      </header>
      {gmStatus && (
        <div role="status" aria-label="สถานะ AI GM" className={`gm-status gm-status--${gmStatus.code}`}>
          <strong>{gmText.status[gmStatus.code]}</strong>
          <span>{gmStatus.message}</span>
        </div>
      )}
      {error && <p role="alert">{error}</p>}

      <div className="gm__cols">
        <div className="gm__col" role="group" aria-label={gmText.columns.people}>
          <Panel label="ตัวละครทั้งหมด">
            <ul className="gm-list">
              {view.characters.map((c) => (
                // The name, Karma and the curses stay bare text of the row; the rest sits in its own parts.
                <li key={c.memberId} className="gm-char">
                  {`${c.name} (${c.playerName})`}
                  <span className="gm-char__meta">{c.appearance}</span>
                  <span className="gm-char__meta">อยู่ที่ {c.locationId ?? '-'}</span>
                  <span className="gm-break" />
                  <span className="gm-num">
                    HP {c.hp.current}/{c.hp.max}
                  </span>
                  <span className="gm-num">
                    Stamina {c.stamina.current}/{c.stamina.max}
                  </span>
                  <span className="gm-break" />
                  {` Karma ${c.karma} `}
                  <span className="gm-char__meta">({c.conduct})</span>
                  <span className="gm-num">
                    ชื่อเสียง {c.reputationScore} <small>{c.socialTitle}</small>
                  </span>
                  {c.curses.length > 0 && <span className="gm-break" />}
                  {c.curses.map((s) => ` · ${curseText(s)}`).join('')}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel label={gmText.npcs}>
            {npcs.length === 0 ? (
              <p className="gm-empty">{gmText.noBonds}</p>
            ) : (
              <ul className="gm-list">
                {npcs.map((n) => (
                  <li key={n.id} className="gm-npc">
                    <strong className="gm-npc__name">{n.name}</strong>
                    {n.bonds.map((b, i) => (
                      <span key={i} className="gm-num">
                        {b.who} {signed(b.affinity)}
                        {!b.nameRevealed && <small> ({gmText.nameHidden})</small>}
                      </span>
                    ))}
                    {n.curses.map((c, i) => (
                      <span key={i} className="gm-curse">
                        {curseText(c)}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {view.npcs === undefined && <p className="gm-pending">{gmText.npcCursesPending}</p>}
          </Panel>

          {playerBonds.length > 0 && (
            <Panel label={gmText.playerBonds}>
              <ul className="gm-list">
                {playerBonds.map((b, i) => (
                  <li key={i}>
                    {b.from} → {b.to} <span className="gm-num">{signed(b.relationship)}</span>
                    {b.alliance ? ` · ${gmText.ally}` : ''}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="gm__col" role="group" aria-label={gmText.columns.turn}>
          {view.pending ? (
            <HeldTurn
              key={JSON.stringify(view.pending)}
              pending={view.pending}
              nameOf={nameOf}
              onSave={(body) => run(() => api.editTurn(body))}
              onApprove={() => run(() => api.approve())}
            />
          ) : (
            <p className="gm-panel gm-empty">ยังไม่มีผลของเทิร์นที่รออนุมัติ</p>
          )}

          <AdjustForm view={view} onAdjust={(body) => run(() => api.adjust(body))} />
          <EventForm onInsert={(body) => run(() => api.insertEvent(body))} />

          <Panel label="action ทั้งหมด" title="action ทั้งหมด (รวม Secret)">
            <ol className="gm-list">
              {view.actions.map((a) => (
                <li key={`${a.day}-${a.phase}-${a.turn}-${a.memberId}`} className={a.visibility === 'secret' ? 'gm-action gm-action--secret' : 'gm-action'}>
                  {`วันที่ ${a.day} · ${PHASE_LABEL[a.phase]} · เทิร์น ${a.turn} · ${nameOf(a.memberId)}: ${a.visibility === 'secret' ? 'Secret' : 'Public'}${a.rest ? ' · REST / SLEEP' : ''} — ${a.text}`}
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="gm__col" role="group" aria-label={gmText.columns.world}>
          <Panel label="เหตุการณ์ตามเส้นเวลา">
            <ul className="gm-list">
              {view.events.map((e) => (
                <li key={e.id}>{`วันที่ ${e.day} · ${PHASE_LABEL[e.phase]} · ${e.title} · ${EVENT_STATUS[e.status]}${e.outcome ? ` · ผล: ${e.outcome}` : ''}${e.outcomeSide ? ` · ฝ่าย: ${OUTCOME_SIDE[e.outcomeSide]}` : ''}`}</li>
              ))}
            </ul>
          </Panel>

          <Panel label="เงื่อนไข Legendary">
            <ul className="gm-list">
              {view.legendaries.map((l) => (
                <li key={l.id}>{`${l.name}: ${l.condition} (${l.progress}/${l.target})${l.unlocked ? ' · ปลดล็อกแล้ว' : ''}`}</li>
              ))}
            </ul>
          </Panel>

          <Panel label={gmText.evidence}>
            {view.evidence.length === 0 ? (
              <p className="gm-empty">{gmText.noEvidence}</p>
            ) : (
              <ul className="gm-list">
                {view.evidence.map((e) => (
                  <li key={e.id}>{`วันที่ ${e.day} · ${e.locationId} · ทิ้งโดย ${nameOf(e.actorMemberId)}`}</li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel label="บรรยายสำรองจากระบบ" title="บรรยายสำรองจากระบบ (AI GM ไม่ได้เขียน)">
            {view.fallbacks.length === 0 ? (
              <p className="gm-empty">ยังไม่มี</p>
            ) : (
              <ol className="gm-list">
                {view.fallbacks.map((f, i) => (
                  <li key={i}>
                    {`วันที่ ${f.at.day} · ${PHASE_LABEL[f.at.phase]} · เทิร์น ${f.at.turn} · ${f.kind === 'narration' ? `ถึง ${nameOf(f.memberId)}` : `ฟีดของ ${f.locationId ?? 'ทั้งเมือง'}`} · ${FALLBACK_CAUSE[f.cause]}`}
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          {/* GEN-126: ตัวอย่างที่ดี = Q-286, ควรเลี่ยง = Q-287 (the server decides both). */}
          <Panel label="โหวตของผู้เล่น" title={votes ? `โหวตของผู้เล่น (ผู้เล่น ${votes.players} คน)` : 'โหวตของผู้เล่น'}>
            {!votes || votes.entries.length === 0 ? (
              <p className="gm-empty">ยังไม่มีใครโหวต</p>
            ) : (
              <ol className="gm-list">
                {votes.entries.map((v) => (
                  <li key={v.seq} aria-label={v.text}>
                    {`วันที่ ${v.at.day} · ${PHASE_LABEL[v.at.phase]} · เทิร์น ${v.at.turn} · ${v.text}`}
                    <span className="gm-break" />
                    <span className="gm-num">ถูกใจ {v.up}</span>
                    <span className="gm-num">ไม่ถูกใจ {v.down}</span>
                    {v.good && <span className="gm-check__outcome gm-check__outcome--ok">ตัวอย่างที่ดี</span>}
                    {v.avoid && <span className="gm-check__outcome gm-check__outcome--bad">ควรเลี่ยง</span>}
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel label="บันทึกการแก้ของ GM">
            {log.length === 0 ? (
              <p className="gm-empty">ยังไม่มีการแก้</p>
            ) : (
              <ol className="gm-list">
                {log.map((o) => (
                  <li key={o.id}>{overrideLine(o)}</li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </section>
  );
}
