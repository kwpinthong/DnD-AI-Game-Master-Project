import {
  PHASES,
  PHASE_LABEL,
  type GmAdjustRequest,
  type GmConsoleResponse,
  type GmInsertEventRequest,
  type GmOverrideView,
  type GmPendingTurn,
  type GmStats,
  type Phase,
} from '@isekai/protocol';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { gmConsoleApi } from './gm-console-api.ts';

const STATS: readonly (keyof GmStats)[] = ['hp', 'stamina', 'karma'];
const STAT_LABEL: Record<keyof GmStats, string> = { hp: 'HP', stamina: 'Stamina', karma: 'Karma' };
const EVENT_STATUS = { pending: 'ยังไม่เกิด', active: 'กำลังเกิด', resolved: 'จบแล้ว' } as const;

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
    <section aria-label="ผลของเทิร์นที่รออนุมัติ">
      <h3>
        ผลของเทิร์นที่รออนุมัติ: วันที่ {pending.at.day} · {PHASE_LABEL[pending.at.phase]} · เทิร์น {pending.at.turn}/2
      </h3>
      <p>ผู้เล่นยังไม่เห็นผลนี้จนกว่าคุณจะกดอนุมัติ</p>
      <form onSubmit={save}>
        {pending.entries.map((e) => (
          <label key={e.index}>
            ข้อความ {e.index + 1} ({e.kind === 'narration' ? `ถึง ${nameOf(e.memberId)} คนเดียว` : `ฟีดของ ${e.locationId ?? 'ทั้งเมือง'}`})
            {e.edited ? ' · แก้แล้ว' : ''}
            <textarea rows={4} value={texts[e.index] ?? ''} onChange={(ev) => setTexts({ ...texts, [e.index]: ev.target.value })} />
          </label>
        ))}
        {pending.results.map((r) => (
          <fieldset key={r.memberId}>
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
        <button type="submit">บันทึกการแก้</button>
        <button type="button" onClick={async () => setError(await onApprove())}>
          อนุมัติและส่งให้ผู้เล่น
        </button>
      </form>
    </section>
  );
}

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
    <form aria-label="ปรับค่าด้วยมือ" onSubmit={submit}>
      <h3>ปรับค่าด้วยมือ (ระหว่างเทิร์น ในกรอบของกฎ)</h3>
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
      {field === 'affinity' && (
        <label>
          NPC id
          <input value={npcId} onChange={(e) => setNpcId(e.target.value)} />
        </label>
      )}
      <label>
        ค่าใหม่
        <input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label>
        เหตุผล
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit">ปรับค่า</button>
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
    <form aria-label="แทรกเหตุการณ์" onSubmit={submit}>
      <h3>แทรกเหตุการณ์ (ช่วงปัจจุบันหรือภายหลัง)</h3>
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
      <button type="submit">แทรกเหตุการณ์</button>
    </form>
  );
}

const overrideLine = (o: GmOverrideView) =>
  `วันที่ ${o.at.day} · ${o.at.phase} · เทิร์น ${o.at.turn} · ${o.gmName} · ${o.kind} · ${o.target} · ${JSON.stringify(o.before)} → ${JSON.stringify(o.after)} · เหตุผล: ${o.reason}`;

/**
 * The Human GM console (GEN-058): every character with Karma, every action (Secret too), the timeline, the
 * Legendary conditions, the turn that waits for approval (Q-030), hand adjustments, new events and the log
 * of every change. Reloads whenever `refreshKey` changes (the room tells it the turn moved).
 */
export function GmConsole({ apiBaseUrl, token, refreshKey }: { apiBaseUrl: string; token: string; refreshKey: string }) {
  const api = useMemo(() => gmConsoleApi(apiBaseUrl, token), [apiBaseUrl, token]);
  const [view, setView] = useState<GmConsoleResponse | null>(null);
  const [log, setLog] = useState<GmOverrideView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [v, l] = await Promise.all([api.view(), api.log()]);
    if (v.ok) setView(v.value);
    if (l.ok) setLog(l.value.overrides);
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

  if (!view) return <section aria-label="GM console">{error ? <p role="alert">{error}</p> : <p>กำลังโหลด GM console…</p>}</section>;
  const nameOf = (memberId: string | null) => view.characters.find((c) => c.memberId === memberId)?.name ?? 'ไม่ทราบชื่อ';

  return (
    <section aria-label="GM console">
      <h2>GM console</h2>
      {error && <p role="alert">{error}</p>}
      {view.pending ? (
        <HeldTurn
          key={JSON.stringify(view.pending)}
          pending={view.pending}
          nameOf={nameOf}
          onSave={(body) => run(() => api.editTurn(body))}
          onApprove={() => run(() => api.approve())}
        />
      ) : (
        <p>ยังไม่มีผลของเทิร์นที่รออนุมัติ</p>
      )}

      <section aria-label="ตัวละครทั้งหมด">
        <h3>ตัวละครทั้งหมด</h3>
        <ul>
          {view.characters.map((c) => (
            <li key={c.memberId}>
              {`${c.name} (${c.playerName}) · HP ${c.hp.current}/${c.hp.max} · Stamina ${c.stamina.current}/${c.stamina.max} · Karma ${c.karma} (${c.conduct}) · ชื่อเสียง ${c.reputationScore} · อยู่ที่ ${c.locationId ?? '-'}`}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="action ทั้งหมด">
        <h3>action ทั้งหมด (รวม Secret)</h3>
        <ol>
          {view.actions.map((a) => (
            <li key={`${a.day}-${a.phase}-${a.turn}-${a.memberId}`}>
              {`วันที่ ${a.day} · ${PHASE_LABEL[a.phase]} · เทิร์น ${a.turn} · ${nameOf(a.memberId)}: ${a.visibility === 'secret' ? 'Secret' : 'Public'}${a.rest ? ' · REST / SLEEP' : ''} — ${a.text}`}
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="เงื่อนไข Legendary">
        <h3>เงื่อนไข Legendary</h3>
        <ul>
          {view.legendaries.map((l) => (
            <li key={l.id}>{`${l.name}: ${l.condition} (${l.progress}/${l.target})${l.unlocked ? ' · ปลดล็อกแล้ว' : ''}`}</li>
          ))}
        </ul>
      </section>

      <section aria-label="เหตุการณ์ตามเส้นเวลา">
        <h3>เหตุการณ์ตามเส้นเวลา</h3>
        <ul>
          {view.events.map((e) => (
            <li key={e.id}>{`วันที่ ${e.day} · ${PHASE_LABEL[e.phase]} · ${e.title} · ${EVENT_STATUS[e.status]}${e.outcome ? ` · ผล: ${e.outcome}` : ''}`}</li>
          ))}
        </ul>
      </section>

      <AdjustForm view={view} onAdjust={(body) => run(() => api.adjust(body))} />
      <EventForm onInsert={(body) => run(() => api.insertEvent(body))} />

      <section aria-label="บันทึกการแก้ของ GM">
        <h3>บันทึกการแก้ของ GM</h3>
        {log.length === 0 ? (
          <p>ยังไม่มีการแก้</p>
        ) : (
          <ol>
            {log.map((o) => (
              <li key={o.id}>{overrideLine(o)}</li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
