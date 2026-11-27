import type { GameLogResponse, RoomEntry } from '@isekai/protocol';
import { useEffect, useId, useState } from 'react';
import { EndingReveal, EndingToc, LearningRetry, RatingSection, useRating, when as at } from './Ending.tsx';
import { fetchGameLog } from './history-api.ts';
import { loadKnownTokens } from './session.ts';
import { TurnChangesList } from './play/TurnChanges.tsx';
import { Button } from './ui/Button.tsx';
import { FeedbackButton } from './ui/FeedbackDialog.tsx';
import { ErrorState, Skeleton } from './ui/parts.tsx';
import { endText, gameClosedText } from './ui/strings.ts';

/**
 * The game list (GEN-037 C3): every game this browser joined or created, newest first, and a read-only
 * summary + log of one. A token the server refuses (expired, logged out, kicked) is left out of this list.
 */

type Loaded = { token: string; log: GameLogResponse } | { token: string; log: 'unreachable' };

function statusText(game: GameLogResponse['game']): string {
  if (game.status === 'lobby') return 'ยังไม่เริ่ม';
  if (game.status === 'playing') return `กำลังเล่น ${game.at ? at(game.at) : ''}`.trim();
  if (game.endReason === 'closed') return gameClosedText.byOwner;
  return game.endReason === 'game_over' ? 'จบแล้ว (ทุกคนสลบ)' : 'จบแล้ว';
}

const KIND_LABEL: Record<RoomEntry['kind'], string> = { feed: 'สิ่งที่เห็น', narration: 'เฉพาะคุณ', whisper: 'กระซิบ', hit: 'เกิดกับคุณ', changes: 'ค่าที่เปลี่ยน', omen: 'ลางสังหรณ์', npc: 'NPC พูด', player: 'ผู้เล่นอื่นทำ', time: 'เวลา', news: 'ข่าวเช้า' };
const EVENT_STATUS: Record<string, string> = { pending: 'ยังไม่ถึง', active: 'กำลังเกิด', resolved: 'จบแล้ว' };

export function GameHistory({ apiBaseUrl, onClose }: { apiBaseUrl: string; onClose: () => void }) {
  const [games, setGames] = useState<Loaded[] | null>(null);
  const [open, setOpen] = useState<{ token: string; log: GameLogResponse } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tokens = loadKnownTokens();
    Promise.all(tokens.map(async (token) => ({ token, log: await fetchGameLog(apiBaseUrl, token) }))).then((results) => {
      if (cancelled) return;
      // ISK-022: a refused token stays kept: เกมของฉัน asks for its PIN.
      setGames(results.filter((r): r is Loaded => r.log !== null));
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  if (open) return <GameLog log={open.log} apiBaseUrl={apiBaseUrl} token={open.token} onBack={() => setOpen(null)} />;

  return (
    <section aria-label="รายการเกม">
      <h2>รายการเกม</h2>
      {games === null && <p>กำลังโหลด…</p>}
      {games !== null && games.length === 0 && <p>ยังไม่มีเกมในเครื่องนี้ เข้าร่วมหรือสร้างเกมก่อน</p>}
      {games !== null && games.length > 0 && (
        <ul aria-label="เกมของฉัน">
          {games.map((g) => {
            const log = g.log;
            return log === 'unreachable' ? (
              <li key={g.token}>โหลดเกมนี้ไม่ได้ ลองใหม่ภายหลัง</li>
            ) : (
              <li key={g.token}>
                <strong>{log.game.name}</strong> — {statusText(log.game)}{' '}
                <button type="button" aria-label={`ดูสรุป ${log.game.name}`} onClick={() => setOpen({ token: g.token, log })}>
                  ดูสรุป
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" onClick={onClose}>
        ปิด
      </button>
    </section>
  );
}

/** Members, timeline and what this viewer received: the read-only log of GEN-037. */
function FullLog({ log }: { log: GameLogResponse }) {
  return (
    <>
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
            {e.whisper ? ` · ${e.whisper.from} → ${e.whisper.to}` : ''}: {e.kind === 'changes' ? <TurnChangesList entry={e} /> : e.text}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * One game, read-only. After the end it is the end page (GEN-091, Screens and Flows v2 §6): the ending,
 * everyone's fate and secrets (GEN-059), the game score + 👍 (GEN-078 contract), then the full log.
 * `apiBaseUrl` + `token` are the session of that game; without them the rating part cannot load.
 */
export function GameLog({ log, onBack, apiBaseUrl, token }: { log: GameLogResponse; onBack: () => void; apiBaseUrl?: string; token?: string }) {
  const ended = log.game.status === 'ended' && log.reveal !== null;
  const rating = useRating(apiBaseUrl, token, ended);
  const id = useId();
  const ids = { ending: `${id}ending`, fates: `${id}fates`, secrets: `${id}secrets`, rating: `${id}rating` };
  return (
    <section aria-label={`สรุปเกม ${log.game.name}`} className="end">
      {/* ISK-011: the report goes with the session of this game, so only a page that has one shows the button. */}
      {ended && apiBaseUrl !== undefined && token && <FeedbackButton apiBaseUrl={apiBaseUrl} token={token} page="ending" />}
      <header className="end__head">
        <h2 className="end__name">{log.game.name}</h2>
        <p className="end__status">
          {statusText(log.game)}
          {log.game.status === 'ended' && log.game.at ? ` · หยุดที่ ${at(log.game.at)}` : ''}
        </p>
      </header>
      {ended && (
        <EndingToc
          parts={[
            { id: ids.ending, label: endText.ending },
            { id: ids.fates, label: endText.fates },
            { id: ids.secrets, label: endText.secrets },
            { id: ids.rating, label: endText.rate },
          ]}
        />
      )}
      {log.reveal && (
        <EndingReveal
          reveal={log.reveal}
          {...(log.game.closedEarly ? { closed: { reason: log.game.closeReason ?? null } } : {})}
          rating={rating.state.state === 'ready' ? rating.state.rating : null}
          onVote={(ref, vote) => void rating.vote(ref, vote)}
          endingId={ids.ending}
          fatesId={ids.fates}
          secretsId={ids.secrets}
        />
      )}
      {ended && <RatingSection rating={rating} id={ids.rating} />}
      {ended && apiBaseUrl !== undefined && token && <LearningRetry apiBaseUrl={apiBaseUrl} token={token} />}

      {ended ? (
        <details className="end-log">
          <summary>{endText.fullLog}</summary>
          <FullLog log={log} />
        </details>
      ) : (
        <FullLog log={log} />
      )}

      <div className="end__actions">
        <Button onClick={onBack}>กลับไปรายการเกม</Button>
      </div>
    </section>
  );
}

/** The end page of the game a session belongs to, loaded by itself (the gallery; GEN-103 can open it from the play room). */
export function GameSummaryPage({ apiBaseUrl, token, onBack }: { apiBaseUrl: string; token: string; onBack: () => void }) {
  const [log, setLog] = useState<GameLogResponse | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLog(null);
    void fetchGameLog(apiBaseUrl, token).then((l) => live && setLog(l === null || l === 'unreachable' ? 'failed' : l));
    return () => {
      live = false;
    };
  }, [apiBaseUrl, token, attempt]);
  if (log === null) return <Skeleton lines={4} />;
  if (log === 'failed') return <ErrorState message="โหลดสรุปเกมไม่ได้" onRetry={() => setAttempt((n) => n + 1)} />;
  return <GameLog log={log} apiBaseUrl={apiBaseUrl} token={token} onBack={onBack} />;
}
