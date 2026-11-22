import { GameRatingRequest, PHASE_LABEL, type EndingPath, type GameLogResponse, type GameRatingView, type GameReveal, type RoomEntry } from '@isekai/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { fetchGameLog, fetchRating, sendRating, setRulingLike } from './history-api.ts';
import { forgetToken, loadKnownTokens } from './session.ts';

/**
 * The game list (GEN-037 C3): every game this browser joined or created, newest first, and a read-only
 * summary + log of one. A token the server refuses (expired, logged out, kicked) is dropped from the list.
 */

type Loaded = { token: string; log: GameLogResponse } | { token: string; log: 'unreachable' };

const at = (p: { day: number; phase: keyof typeof PHASE_LABEL; turn?: number }) =>
  `วันที่ ${p.day} · ${PHASE_LABEL[p.phase]}${p.turn === undefined ? '' : ` · เทิร์น ${p.turn}/2`}`;

function statusText(game: GameLogResponse['game']): string {
  if (game.status === 'lobby') return 'ยังไม่เริ่ม';
  if (game.status === 'playing') return `กำลังเล่น ${game.at ? at(game.at) : ''}`.trim();
  return game.endReason === 'game_over' ? 'จบแล้ว (ทุกคนสลบ)' : 'จบแล้ว';
}

const KIND_LABEL: Record<RoomEntry['kind'], string> = { feed: 'สิ่งที่เห็น', narration: 'เฉพาะคุณ', whisper: 'กระซิบ', hit: 'เกิดกับคุณ', omen: 'ลางสังหรณ์' };
const EVENT_STATUS: Record<string, string> = { pending: 'ยังไม่ถึง', active: 'กำลังเกิด', resolved: 'จบแล้ว' };

export function GameHistory({ apiBaseUrl, onClose }: { apiBaseUrl: string; onClose: () => void }) {
  const [games, setGames] = useState<Loaded[] | null>(null);
  const [open, setOpen] = useState<{ token: string; log: GameLogResponse } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tokens = loadKnownTokens();
    Promise.all(tokens.map(async (token) => ({ token, log: await fetchGameLog(apiBaseUrl, token) }))).then((results) => {
      if (cancelled) return;
      for (const r of results) if (r.log === null) forgetToken(r.token);
      setGames(results.filter((r): r is Loaded => r.log !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  if (open) return <GameLog log={open.log} session={{ apiBaseUrl, token: open.token }} onBack={() => setOpen(null)} />;

  return (
    <section aria-label="รายการเกม">
      <h2>รายการเกม</h2>
      {games === null && <p>กำลังโหลด…</p>}
      {games !== null && games.length === 0 && <p>ยังไม่มีเกมในเครื่องนี้ เข้าร่วมหรือสร้างเกมก่อน</p>}
      {games !== null && games.length > 0 && (
        <ul aria-label="เกมของฉัน">
          {games.map((g) =>
            g.log === 'unreachable' ? (
              <li key={g.token}>โหลดเกมนี้ไม่ได้ ลองใหม่ภายหลัง</li>
            ) : (
              <li key={g.token}>
                <strong>{g.log.game.name}</strong> — {statusText(g.log.game)}{' '}
                <button type="button" aria-label={`ดูสรุป ${g.log.game.name}`} onClick={() => setOpen({ token: g.token, log: g.log as GameLogResponse })}>
                  ดูสรุป
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      <button type="button" onClick={onClose}>
        ปิด
      </button>
    </section>
  );
}

const PATH_TEXT: Record<EndingPath, string> = {
  good: 'เส้นทาง Good: ม่านปาฏิหาริย์เบี่ยงอุกกาบาตปกป้องเมือง',
  evil: 'เส้นทาง Evil: ดูดซับพลังอุกกาบาตครองโลก',
  neutral: 'เส้นทาง Neutral: ร่วมกับแอสทราและเซเรน่าลบล้างผลเป็นศูนย์',
  none: 'ไม่มีเส้นทางใดสำเร็จ: อุกกาบาตชนเมือง',
};
const OUTCOME_TEXT = { survived: 'รอดชีวิต', defeated: 'พ่ายแพ้ (Bad Ending)' } as const;

interface RatingSession {
  apiBaseUrl: string;
  token: string;
}

/** GEN-078: one score 1–10 + an optional comment per member; sending again replaces it. */
function RatingForm({ rating, session, onRating }: { rating: GameRatingView; session: RatingSession; onRating: (rating: GameRatingView) => void }) {
  const [score, setScore] = useState(rating.mine ? String(rating.mine.score) : '');
  const [comment, setComment] = useState(rating.mine?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = GameRatingRequest.safeParse({ score: score === '' ? undefined : Number(score), comment });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'เลือกคะแนน 1–10');
    setError(null);
    setSending(true);
    const result = await sendRating(session.apiBaseUrl, session.token, parsed.data);
    setSending(false);
    if (result.ok) onRating(result.rating);
    else setError(result.message);
  }

  return (
    <form onSubmit={submit} noValidate>
      {rating.mine && <p role="status">ส่งคะแนนแล้ว: {rating.mine.score}/10 (แก้ได้)</p>}
      <label>
        คะแนน 1–10
        <select value={score} onChange={(e) => setScore(e.target.value)}>
          <option value="">เลือก</option>
          {Array.from({ length: 10 }, (_, i) => String(i + 1)).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label>
        ความเห็น (ไม่บังคับ)
        <textarea value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={sending}>
        {rating.mine ? 'แก้คะแนน' : 'ส่งคะแนน'}
      </button>
      <p>
        คะแนนเกม: {rating.average === null ? 'ยังไม่มี' : rating.average.toFixed(1)} · ให้แล้ว {rating.raters}/{rating.members} คน
      </p>
    </form>
  );
}

/** GEN-059 C5: the secrets of everyone, only once the game ended (the server sends `reveal` then only). */
function Reveal({ reveal, session }: { reveal: GameReveal; session?: RatingSession | undefined }) {
  // GEN-078: the caller's score and 👍; null until loaded (or without a session: the dev gallery).
  const [rating, setRating] = useState<GameRatingView | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void fetchRating(session.apiBaseUrl, session.token).then((result) => {
      if (!cancelled && result.ok) setRating(result.rating);
    });
    return () => {
      cancelled = true;
    };
  }, [session?.apiBaseUrl, session?.token]);

  async function toggleLike(sourceRef: string) {
    if (!session || !rating) return;
    const result = await setRulingLike(session.apiBaseUrl, session.token, sourceRef, !rating.liked.includes(sourceRef));
    if (result.ok) setRating(result.rating);
  }

  return (
    <section aria-label="ความลับของทุกคน">
      <h3>ความลับของทุกคน</h3>
      <p>{reveal.path === null ? 'ไม่มีบันทึกตอนจบ' : PATH_TEXT[reveal.path]}</p>
      {reveal.players.map((p) => (
        <article key={p.memberId} aria-label={p.lobbyName}>
          <h4>{p.lobbyName}</h4>
          <dl>
            <dt>ชื่อจริง</dt>
            <dd>{p.characterName}</dd>
            <dt>ระดับกรรม</dt>
            {/* Q-196: the tier word is the label, the number small beside it. */}
            <dd>
              <span>{p.karmaTier}</span> <small>({p.karma})</small>
            </dd>
            <dt>ตอนจบ</dt>
            <dd>{p.outcome === null ? 'ไม่มีบันทึก' : OUTCOME_TEXT[p.outcome]}</dd>
            <dt>จุดเกิด</dt>
            <dd>{p.spawn ?? 'ไม่มีบันทึก'}</dd>
            <dt>คู่หู</dt>
            <dd>{p.companions.length === 0 ? 'ไม่มี' : p.companions.join(', ')}</dd>
            <dt>Secret action</dt>
            <dd>
              {p.secretActions.length === 0 ? (
                'ไม่มี Secret action'
              ) : (
                <ul>
                  {p.secretActions.map((s, i) => (
                    <li key={i}>
                      {at(s)}: {s.text}
                      {rating && s.sourceRef !== undefined && (
                        <>
                          {' '}
                          <button
                            type="button"
                            aria-label={`👍 ${s.text}`}
                            aria-pressed={rating.liked.includes(s.sourceRef)}
                            onClick={() => void toggleLike(s.sourceRef!)}
                          >
                            👍 {rating.thumbs?.[s.sourceRef] ?? 0}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        </article>
      ))}
      <section aria-label="ให้คะแนนเกม">
        {rating && session && (
          <>
            <h3>ให้คะแนนเกม</h3>
            <RatingForm rating={rating} session={session} onRating={setRating} />
          </>
        )}
      </section>
    </section>
  );
}

/** One game, read-only; after the end with the secret reveal (GEN-059). Exported for the dev gallery (GEN-100). */
export function GameLog({ log, onBack, session }: { log: GameLogResponse; onBack: () => void; session?: { apiBaseUrl: string; token: string } }) {
  return (
    <section aria-label={`สรุปเกม ${log.game.name}`}>
      <h2>{log.game.name}</h2>
      <p>
        {statusText(log.game)}
        {log.game.status === 'ended' && log.game.at ? ` · หยุดที่ ${at(log.game.at)}` : ''}
      </p>
      {log.reveal && <Reveal reveal={log.reveal} session={session} />}

      <h3>ผู้เล่น</h3>
      <ul aria-label="ผู้เล่น">
        {log.members.map((m, i) => (
          <li key={i}>{m.role === 'gm' ? `${m.name} (GM)` : m.name}</li>
        ))}
      </ul>

      <h3>เหตุการณ์</h3>
      <ul aria-label="เหตุการณ์">
        {log.timeline.events.length === 0 && <li>ยังไม่มี</li>}
        {log.timeline.events.map((e) => (
          <li key={e.id}>
            {at(e)}: {e.title} ({EVENT_STATUS[e.status] ?? e.status})
            {log.timeline.view === 'gm' && 'outcome' in e && e.outcome ? ` — ${e.outcome}` : ''}
          </li>
        ))}
      </ul>

      <h3>บันทึกของคุณ</h3>
      <ul aria-label="บันทึกของคุณ">
        {log.entries.length === 0 && <li>ยังไม่มี</li>}
        {log.entries.map((e) => (
          <li key={e.seq}>
            {at(e)} · {KIND_LABEL[e.kind]}
            {e.place ? ` · ${e.place.name}` : ''}
            {e.whisper ? ` · ${e.whisper.from} → ${e.whisper.to}` : ''}: {e.text}
          </li>
        ))}
      </ul>

      <button type="button" onClick={onBack}>
        กลับไปรายการเกม
      </button>
    </section>
  );
}
