import type { AiUsageGameResponse, AiUsageOverviewResponse, UsageCeiling, UsageFailure, UsageTotals } from '@isekai/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchGameUsage, fetchUsageOverview, postAdminLogout, postAdminSession } from './admin-api.ts';
import { GameDataEditor } from './GameDataEditor.tsx';
import { LearningLibrary } from './LearningLibrary.tsx';
import { NpcLibrary } from './NpcLibrary.tsx';
import { VoteReview } from './VoteReview.tsx';
import { StylePanel } from './StylePanel.tsx';
import { StyleEval } from './StyleEval.tsx';
import { libraryText, npcLibraryText } from './ui/strings.ts';

/**
 * The server owner's AI usage dashboard at <web>/admin (GEN-061, Q-058). Numbers and purposes only:
 * the server never sends narration, names, karma or actions here.
 */

/** Refresh period while the page is open (C7: new calls show within 30 s). */
export const USAGE_POLL_MS = 10_000;
/** sessionStorage key of the admin token: it lasts one hour on the server and dies with the tab here. */
export const ADMIN_TOKEN_KEY = 'isekai.adminToken';

function loadAdminToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveAdminToken(token: string | null) {
  try {
    if (token === null) sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    else sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    // storage blocked: the token lasts only this page
  }
}

const PURPOSE_LABEL: Record<string, string> = {
  gm_adjudicate: 'ตัดสินผล (resolve phase)',
  gm_repair: 'ซ่อมคำตอบ (repair)',
  narrate_place: 'เล่าเรื่องสถานที่',
  narrate_player: 'เล่าเรื่องผู้เล่น',
  npc_dialogue: 'บทพูด NPC',
  summarize_day: 'สรุปความจำรายวัน',
  summarize_journal: 'สรุปบันทึก',
  finale: 'ฉากจบ (finale)',
  character_analyze: 'loot ตอนสร้างตัวละคร',
};

const FAILURE_LABEL: Record<string, string> = {
  timeout: 'หมดเวลา (timeout)',
  refusal: 'AI ปฏิเสธ (refusal)',
  invalid_json: 'JSON ผิด (invalid_json)',
  schema_mismatch: 'JSON ไม่ตรง schema (schema_mismatch)',
  max_tokens: 'คำตอบยาวเกิน (max_tokens)',
  rate_limited: 'ติด rate limit (rate_limited)',
  provider_error: 'provider ผิดพลาด (provider_error)',
  aborted: 'ยกเลิก (aborted)',
};

const PERIODS = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

const n = (value: number) => value.toLocaleString('en-US');
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

/** Cost of a group: unknown (not $0) when its calls used a model with no price (C8). */
function costText(t: UsageTotals): string {
  if (t.unpricedCalls === 0) return usd(t.costUsdMicros);
  if (t.unpricedCalls === t.calls) return 'ไม่ทราบราคา';
  return `${usd(t.costUsdMicros)} + ไม่ทราบราคา (${t.unpricedCalls} call)`;
}

function ceilingText(c: UsageCeiling): string {
  if (c.status === 'reached') return `ถึงเพดาน (${c.percent}%)`;
  if (c.status === 'warning') return `${c.percent}% ใกล้เพดาน`;
  return `${c.percent}%`;
}

type View =
  | { state: 'login'; message?: string }
  | { state: 'dashboard'; token: string };

export function AdminDashboard({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [view, setView] = useState<View>(() => {
    const token = loadAdminToken();
    return token ? { state: 'dashboard', token } : { state: 'login' };
  });

  const [page, setPage] = useState<'usage' | 'library' | 'data' | 'votes'>('usage');

  function signedIn(token: string) {
    saveAdminToken(token);
    setView({ state: 'dashboard', token });
  }

  function signedOut(message?: string) {
    saveAdminToken(null);
    setView({ state: 'login', ...(message ? { message } : {}) });
  }

  return (
    <main className="admin">
      <h1>Isekai Chronicles: ผู้ดูแล</h1>
      {view.state === 'login' ? (
        <AdminLogin apiBaseUrl={apiBaseUrl} onSignedIn={signedIn} {...(view.message ? { notice: view.message } : {})} />
      ) : (
        <>
          {/* GEN-091: both pages sit behind the same admin code (Q-168). */}
          <nav className="admin__nav" aria-label="ผู้ดูแล">
            {(['usage', 'library', 'data', 'votes'] as const).map((p) => (
              <button key={p} type="button" aria-pressed={page === p} onClick={() => setPage(p)}>
                {libraryText.adminNav[p]}
              </button>
            ))}
          </nav>
          {page === 'usage' ? (
            <Dashboard
              apiBaseUrl={apiBaseUrl}
              token={view.token}
              onForbidden={signedOut}
              onLogout={() => {
                void postAdminLogout(apiBaseUrl, view.token);
                signedOut();
              }}
            />
          ) : page === 'library' ? (
            <section aria-label={libraryText.title}>
              <h2>{libraryText.title}</h2>
              <LearningLibrary apiBaseUrl={apiBaseUrl} token={view.token} onForbidden={signedOut} />
              {/* GEN-151 / Q-322: the NPC example library shares the page. */}
              <h2>{npcLibraryText.title}</h2>
              <NpcLibrary apiBaseUrl={apiBaseUrl} token={view.token} onForbidden={signedOut} />
            </section>
          ) : page === 'votes' ? (
            <section aria-label={libraryText.adminNav.votes}>
              <h2>{libraryText.adminNav.votes}</h2>
              <VoteReview apiBaseUrl={apiBaseUrl} token={view.token} onForbidden={signedOut} />
              <StylePanel apiBaseUrl={apiBaseUrl} token={view.token} onForbidden={signedOut} />
              {/* GEN-167: the fixed eval set, previous round vs this round. */}
              <StyleEval apiBaseUrl={apiBaseUrl} token={view.token} onForbidden={signedOut} />
            </section>
          ) : (
            <section aria-label={libraryText.adminNav.data}>
              <h2>{libraryText.adminNav.data}</h2>
              <GameDataEditor apiBaseUrl={apiBaseUrl} token={view.token} onForbidden={signedOut} />
            </section>
          )}
        </>
      )}
    </main>
  );
}

function AdminLogin({ apiBaseUrl, onSignedIn, notice }: { apiBaseUrl: string; onSignedIn: (token: string) => void; notice?: string }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(notice);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await postAdminSession(apiBaseUrl, code);
    setBusy(false);
    if (result.kind === 'ok') onSignedIn(result.data.token);
    else setError(result.message);
  }

  return (
    <form onSubmit={submit}>
      <p>หน้านี้สำหรับเจ้าของ server เท่านั้น</p>
      <label>
        admin code
        <input type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <button type="submit" disabled={busy}>
        เข้า dashboard
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function Dashboard({
  apiBaseUrl,
  token,
  onForbidden,
  onLogout,
}: {
  apiBaseUrl: string;
  token: string;
  onForbidden: (message: string) => void;
  onLogout: () => void;
}) {
  const [overview, setOverview] = useState<AiUsageOverviewResponse>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<AiUsageGameResponse>();
  const [error, setError] = useState<string>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      const gameId = selectedRef.current;
      const [all, one] = await Promise.all([
        fetchUsageOverview(apiBaseUrl, token),
        gameId ? fetchGameUsage(apiBaseUrl, token, gameId) : Promise.resolve(undefined),
      ]);
      if (cancelled) return;
      const forbidden = [all, one].find((r) => r?.kind === 'forbidden');
      if (forbidden && forbidden.kind === 'forbidden') return onForbiddenRef.current(forbidden.message);
      if (all.kind === 'ok') setOverview(all.data);
      if (one?.kind === 'ok' && selectedRef.current === gameId) setDetail(one.data);
      const failed = [all, one].find((r) => r?.kind === 'error');
      setError(failed && failed.kind === 'error' ? failed.message : undefined);
      timer = setTimeout(refresh, USAGE_POLL_MS);
    }

    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `selected` restarts the loop so a newly opened game loads at once.
  }, [apiBaseUrl, token, selected]);

  return (
    <>
      <button type="button" onClick={onLogout}>
        ออกจาก dashboard
      </button>
      <h2>การใช้ AI ทุกเกม</h2>
      {error && <p role="status">{error}</p>}
      {overview === undefined ? (
        <p>กำลังโหลด…</p>
      ) : (
        <>
          <section aria-label="ยอดรวมทุกเกม">
            {overview.totals.calls === 0 ? <p>ยังไม่มีการเรียก AI</p> : <TotalsTable label="ยอดรวมทุกเกม (ตาราง)" totals={overview.totals} />}
            <p>อัปเดตล่าสุด {new Date(overview.generatedAt).toLocaleTimeString('th-TH', { hour12: false })} (อัปเดตเองทุก {USAGE_POLL_MS / 1000} วินาที)</p>
          </section>
          <table aria-label="รายเกม">
            <thead>
              <tr>
                <th>เกม</th>
                <th>call</th>
                <th>input</th>
                <th>output</th>
                <th>ค่าใช้จ่ายประมาณ</th>
                <th>เพดานเดือนนี้</th>
              </tr>
            </thead>
            <tbody>
              {overview.games.map(({ game, totals, ceiling }) => (
                <tr key={game.id}>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setDetail(undefined);
                        setSelected(game.id);
                      }}
                    >
                      {game.name ?? `เกมที่ลบแล้ว (${game.id})`}
                    </button>
                  </td>
                  <td>{n(totals.calls)}</td>
                  <td>{n(totals.inputTokens)}</td>
                  <td>{n(totals.outputTokens)}</td>
                  <td>{totals.calls === 0 ? '–' : costText(totals)}</td>
                  <td>{ceilingText(ceiling)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {selected && detail && <GameUsage usage={detail} onClose={() => setSelected(undefined)} />}
    </>
  );
}

function GameUsage({ usage, onClose }: { usage: AiUsageGameResponse; onClose: () => void }) {
  const name = usage.game.name ?? `เกมที่ลบแล้ว (${usage.game.id})`;
  return (
    <section aria-label={`เกม ${name}`}>
      <h3>{name}</h3>
      <button type="button" onClick={onClose}>
        ปิด
      </button>
      <Ceiling ceiling={usage.ceiling} />
      {usage.totals.calls === 0 ? (
        <p>เกมนี้ยังไม่มีการเรียก AI</p>
      ) : (
        <>
          <TotalsTable label="ยอดรวม" totals={usage.totals} />
          <GroupTable
            label="แยกตาม purpose"
            head="purpose"
            rows={usage.byPurpose.map((p) => ({ key: p.purpose, name: PURPOSE_LABEL[p.purpose] ?? p.purpose, totals: p.totals }))}
          />
          <PeriodGrid usage={usage} />
          <GroupTable
            label="แยกตาม model"
            head="model"
            rows={usage.byModel.map((m) => ({ key: m.model, name: m.model, totals: m.totals, unpriced: !m.priced }))}
          />
          {usage.failures.length > 0 && <Failures failures={usage.failures} />}
        </>
      )}
    </section>
  );
}

function Ceiling({ ceiling }: { ceiling: UsageCeiling }) {
  return (
    <div>
      <p>
        เพดานเดือนนี้: {usd(ceiling.spentUsdMicros)} / {usd(ceiling.ceilingUsdMicros)}{' '}
        <progress value={Math.min(ceiling.percent, 100)} max={100} aria-label="ใช้ไปของเพดาน" style={{ width: '12rem' }} />
      </p>
      {ceiling.status === 'warning' && <p role="alert">เตือน: ใช้ไปแล้ว {ceiling.percent}% ของเพดานเดือนนี้</p>}
      {ceiling.status === 'reached' && (
        <p role="alert">AI GM หยุดเพราะถึงเพดานแล้ว ({ceiling.percent}%) จะเรียกได้อีกเมื่อขึ้นเดือนใหม่ หรือเมื่อปรับ AI_GAME_MONTHLY_USD</p>
      )}
    </div>
  );
}

function TotalsTable({ label, totals }: { label: string; totals: UsageTotals }) {
  const rows: [string, string][] = [
    ['call ทั้งหมด', n(totals.calls)],
    ['สำเร็จ', n(totals.okCalls)],
    ['ล้มเหลว', n(totals.failedCalls)],
    ['input', n(totals.inputTokens)],
    ['cached', n(totals.cachedInputTokens)],
    ['cache write', n(totals.cacheWriteTokens)],
    ['output', n(totals.outputTokens)],
    ['ค่าใช้จ่ายประมาณ', costText(totals)],
  ];
  return (
    <table aria-label={label}>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GroupTable({
  label,
  head,
  rows,
}: {
  label: string;
  head: string;
  rows: { key: string; name: string; totals: UsageTotals; unpriced?: boolean }[];
}) {
  return (
    <table aria-label={label}>
      <thead>
        <tr>
          <th>{head}</th>
          <th>call</th>
          <th>input</th>
          <th>cached</th>
          <th>output</th>
          <th>ค่าใช้จ่ายประมาณ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.name}</th>
            <td>{n(r.totals.calls)}</td>
            <td>{n(r.totals.inputTokens)}</td>
            <td>{n(r.totals.cachedInputTokens)}</td>
            <td>{n(r.totals.outputTokens)}</td>
            <td>{r.unpriced ? 'ไม่ทราบราคา' : costText(r.totals)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PeriodGrid({ usage }: { usage: AiUsageGameResponse }) {
  const days = [...new Set(usage.byPeriod.map((p) => p.day).filter((d): d is number => d !== null))].sort((a, b) => a - b);
  const cell = (day: number | null, phase: string | null) => usage.byPeriod.find((p) => p.day === day && p.phase === phase)?.totals;
  const outside = usage.byPeriod.filter((p) => p.day === null || p.phase === null);
  const text = (t: UsageTotals | undefined) => (t ? `in ${n(t.inputTokens)} / out ${n(t.outputTokens)} (${t.calls} call)` : '–');

  return (
    <table aria-label="แยกตามวันและช่วงเวลา">
      <thead>
        <tr>
          <th>วัน</th>
          {PERIODS.map((p) => (
            <th key={p}>{p}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day}>
            <th scope="row">วัน {day}</th>
            {PERIODS.map((phase) => (
              <td key={phase} data-testid={`period-${day}-${phase}`}>
                {text(cell(day, phase))}
              </td>
            ))}
          </tr>
        ))}
        {outside.map((p) => (
          <tr key={`${p.day}-${p.phase}`}>
            <th scope="row">{p.day === null ? 'นอกวันเล่น (เช่น loot ตอนสร้างตัวละคร)' : `วัน ${p.day} ไม่ระบุช่วง`}</th>
            <td colSpan={PERIODS.length} data-testid={`period-${p.day ?? 'none'}-${p.phase ?? 'none'}`}>
              {text(p.totals)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Failures({ failures }: { failures: UsageFailure[] }) {
  return (
    <table aria-label="call ที่ล้มเหลว">
      <thead>
        <tr>
          <th>สาเหตุ</th>
          <th>จำนวน</th>
        </tr>
      </thead>
      <tbody>
        {failures.map((f) => (
          <tr key={f.kind}>
            <th scope="row">{FAILURE_LABEL[f.kind] ?? f.kind}</th>
            <td>{n(f.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
