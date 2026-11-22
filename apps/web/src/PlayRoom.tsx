import { ACTION_MAX_LENGTH, actionTextProblem, type ActionVisibility, type RoomEntry, type RoomState } from '@isekai/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { connectRoom, type RoomConnection, type RoomConnectionStatus } from './room-api.ts';

const phaseLabel = { MORNING: 'เช้า', AFTERNOON: 'บ่าย', NIGHT: 'ค่ำ' } as const;
const statusLabel = {
  collecting: 'รอ action จากผู้เล่น',
  resolving: 'ปิดรับแล้ว กำลังสรุปผล…',
  finale: 'ฉากจบ',
  game_over: 'เกมจบแล้ว',
} as const;
const connectionLabel: Record<RoomConnectionStatus, string> = {
  connecting: 'กำลังเชื่อมต่อห้อง…',
  online: 'เชื่อมต่อแล้ว',
  reconnecting: 'หลุดการเชื่อมต่อ กำลังต่อใหม่… (ของที่พลาดจะตามมาครบ)',
  closed: 'ปิดการเชื่อมต่อแล้ว',
};

function entryHeading(e: RoomEntry): string {
  return `วันที่ ${e.day} ${phaseLabel[e.phase]}${e.place ? ` · ${e.place.name}` : ''}`;
}

function EntryList({ label, entries, empty }: { label: string; entries: RoomEntry[]; empty: string }) {
  return (
    <section aria-label={label}>
      <h3>{label}</h3>
      {entries.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ol>
          {entries.map((e) => (
            <li key={e.seq}>
              <small>{entryHeading(e)}</small>
              <p>{e.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The play room (GEN-056, Online and Single alike): who is online and who has sent this phase's action
 * (never what they sent), your action form (Public / Secret), the feed of your place and your private
 * narration. Reconnects by itself and fills in what it missed.
 */
export function PlayRoom({
  apiBaseUrl,
  token,
  onBack,
  onNeedCharacter,
  onSessionLost,
}: {
  apiBaseUrl: string;
  token: string;
  onBack: () => void;
  /** The server says this player has no character yet (C2). */
  onNeedCharacter: () => void;
  onSessionLost: () => void;
}) {
  const [connection, setConnection] = useState<RoomConnectionStatus>('connecting');
  const [room, setRoom] = useState<RoomState>();
  const [entries, setEntries] = useState<RoomEntry[]>([]);
  const [fatal, setFatal] = useState<string>();
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<ActionVisibility>('public');
  const [problem, setProblem] = useState<string>();
  const [waitingReply, setWaitingReply] = useState(false);
  const conn = useRef<RoomConnection | undefined>(undefined);

  useEffect(() => {
    const c = connectRoom(apiBaseUrl, token, {
      status: setConnection,
      room: setRoom,
      entry: (entry) => setEntries((list) => [...list, entry]),
      actionReply: (reply) => {
        setWaitingReply(false);
        if (reply.ok) {
          setProblem(undefined);
          setText('');
        } else setProblem(reply.message);
      },
      fatal: (code, message) => {
        if (code === 'no_character') onNeedCharacter();
        else if (code === 'unauthorized') onSessionLost();
        else setFatal(message);
      },
    });
    conn.current = c;
    return () => c.close();
    // One socket per token; the callbacks are stable enough for the life of the page.
  }, [apiBaseUrl, token]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const local = actionTextProblem(text);
    if (local) return setProblem(local.message);
    if (!conn.current?.sendAction(text, visibility)) return setProblem('ยังเชื่อมต่อไม่ได้ ลองอีกครั้งเมื่อขึ้นว่าเชื่อมต่อแล้ว');
    setWaitingReply(true);
  }

  const feed = entries.filter((e) => e.kind === 'feed');
  const narration = entries.filter((e) => e.kind === 'narration');
  const you = room?.you;
  const locked = !you || you.lock !== null;
  const left = ACTION_MAX_LENGTH - [...text].length;

  return (
    <section aria-label="ห้องเล่น">
      <h2>
        ห้องเล่น
        {room && ` · วันที่ ${room.day} · ${phaseLabel[room.phase]}`}
        {room?.mode === 'single' && ' · เล่นคนเดียว'}
      </h2>
      <p role="status" aria-label="การเชื่อมต่อห้อง" data-connection={connection}>
        {connectionLabel[connection]}
      </p>
      {fatal && <p role="alert">{fatal}</p>}
      <button type="button" onClick={onBack}>
        กลับห้องรอ
      </button>

      {room && you && (
        <>
          <p>{statusLabel[room.status]}</p>
          {you.place && <p>คุณอยู่ที่: {you.place.name}</p>}

          <ul aria-label="ผู้เล่นในห้อง">
            {room.members.map((m) => (
              <li key={m.memberId}>
                {m.name}
                {m.memberId === you.memberId && ' (คุณ)'} — {m.online ? 'ออนไลน์' : 'ออฟไลน์'}
                {m.role === 'gm' ? ' · GM' : m.submitted ? ' · ส่งแล้ว' : ' · ยังไม่ส่ง'}
              </li>
            ))}
          </ul>

          {you.role === 'player' && (
            <form onSubmit={submit} aria-label="ส่ง action">
              {you.action && (
                <p>
                  ส่งแล้ว ({you.action.visibility === 'secret' ? 'Secret' : 'Public'}): {you.action.text}
                  {room.status === 'collecting' && <small> (ส่งใหม่เพื่อแทนของเดิมได้จนกว่า phase จะปิด)</small>}
                </p>
              )}
              {you.lock && <p role="note">{you.lock.message}</p>}
              <label>
                action ของคุณ
                <textarea value={text} disabled={locked} onChange={(e) => setText(e.target.value)} rows={4} />
              </label>
              <small>{left >= 0 ? `เหลือ ${left} ตัวอักษร` : `เกิน ${-left} ตัวอักษร`}</small>
              <fieldset disabled={locked}>
                <legend>ใครเห็น</legend>
                <label>
                  <input type="radio" name="visibility" checked={visibility === 'public'} onChange={() => setVisibility('public')} />
                  Public (คนที่อยู่ที่เดียวกันเห็นผล)
                </label>
                <label>
                  <input
                    type="radio"
                    name="visibility"
                    checked={visibility === 'secret'}
                    disabled={you.secretUsedToday}
                    onChange={() => setVisibility('secret')}
                  />
                  Secret (เห็นคนเดียว ได้วันละ 1 phase{you.secretUsedToday ? ' · วันนี้ใช้แล้ว' : ''})
                </label>
              </fieldset>
              <button type="submit" disabled={locked || waitingReply}>
                {you.action ? 'ส่งแทนของเดิม' : 'ส่ง action'}
              </button>
              {problem && <p role="alert">{problem}</p>}
            </form>
          )}

          <EntryList label="เหตุการณ์ที่นี่" entries={feed} empty="ยังไม่มีอะไรเกิดขึ้นที่นี่" />
          <EntryList label="สิ่งที่คุณรู้คนเดียว" entries={narration} empty="ยังไม่มี" />
        </>
      )}
    </section>
  );
}
