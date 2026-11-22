import { PHASE_LABEL, type EndingPath, type GameLogResponse, type GameReveal, type RoomEntry } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { fetchGameLog } from './history-api.ts';
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
  const [open, setOpen] = useState<GameLogResponse | null>(null);

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

  if (open) return <GameLog log={open} onBack={() => setOpen(null)} />;

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
                <button type="button" aria-label={`ดูสรุป ${g.log.game.name}`} onClick={() => setOpen(g.log as GameLogResponse)}>
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

/** GEN-059 C5: the secrets of everyone, only once the game ended (the server sends `reveal` then only). */
function Reveal({ reveal }: { reveal: GameReveal }) {
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
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        </article>
      ))}
      {/* GEN-077 / GEN-078: the rating form goes here. */}
      <section aria-label="ให้คะแนนเกม" />
    </section>
  );
}

/** One game, read-only; after the end with the secret reveal (GEN-059). Exported for the dev gallery (GEN-100). */
export function GameLog({ log, onBack }: { log: GameLogResponse; onBack: () => void }) {
  return (
    <section aria-label={`สรุปเกม ${log.game.name}`}>
      <h2>{log.game.name}</h2>
      <p>
        {statusText(log.game)}
        {log.game.status === 'ended' && log.game.at ? ` · หยุดที่ ${at(log.game.at)}` : ''}
      </p>
      {log.reveal && <Reveal reveal={log.reveal} />}

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
