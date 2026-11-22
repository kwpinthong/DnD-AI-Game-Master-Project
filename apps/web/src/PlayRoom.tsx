import { ACTION_MAX_LENGTH, PHASE_LABEL, actionTextProblem, type ActionVisibility, type RoomEntry, type RoomState } from '@isekai/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { GmConsole } from './GmConsole.tsx';
import { connectRoom, type RoomConnection, type RoomConnectionStatus } from './room-api.ts';

/** "วันที่ 1 · EOSORIA (เช้า 06:00-11:59) · เทิร์น 1/2" (GEN-063: 4 periods x 2 turns). */
const timeLabel = (t: Pick<RoomEntry, 'day' | 'phase' | 'turn'>) => `วันที่ ${t.day} · ${PHASE_LABEL[t.phase]} · เทิร์น ${t.turn}/2`;
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
  return `${timeLabel(e)}${e.place ? ` · ${e.place.name}` : ''}`;
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
 * The play room (GEN-056, Online and Single alike): who is online and who has sent this turn's action
 * (never what they sent), your action form (Public / Secret, REST / SLEEP), the feed of your place and your
 * private narration. Reconnects by itself and fills in what it missed.
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
  const [rest, setRest] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [waitingReply, setWaitingReply] = useState(false);
  const [whisperTo, setWhisperTo] = useState('');
  const [whisperText, setWhisperText] = useState('');
  const [whisperProblem, setWhisperProblem] = useState<string>();
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
          setRest(false);
        } else setProblem(reply.message);
      },
      whisperReply: (reply) => {
        if (reply.ok) {
          setWhisperProblem(undefined);
          setWhisperText('');
        } else setWhisperProblem(reply.message);
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
    if (!conn.current?.sendAction(text, visibility, rest)) return setProblem('ยังเชื่อมต่อไม่ได้ ลองอีกครั้งเมื่อขึ้นว่าเชื่อมต่อแล้ว');
    setWaitingReply(true);
  }

  function sendWhisper(event: FormEvent, fallbackTo: string) {
    event.preventDefault();
    const local = actionTextProblem(whisperText);
    if (local) return setWhisperProblem(local.code === 'empty' ? 'พิมพ์ข้อความก่อนส่ง Whisper' : local.message);
    if (!conn.current?.sendWhisper(whisperTo || fallbackTo, whisperText)) {
      return setWhisperProblem('ยังเชื่อมต่อไม่ได้ ลองอีกครั้งเมื่อขึ้นว่าเชื่อมต่อแล้ว');
    }
  }

  const feed = entries.filter((e) => e.kind === 'feed');
  const narration = entries.filter((e) => e.kind === 'narration');
  const whispers = entries.filter((e) => e.kind === 'whisper');
  const you = room?.you;
  const allies = you?.allies ?? [];
  const locked = !you || you.lock !== null;
  const left = ACTION_MAX_LENGTH - [...text].length;

  return (
    <section aria-label="ห้องเล่น">
      <h2>
        ห้องเล่น
        {room && ` · ${timeLabel(room)}`}
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
          {room.gmStatus && (
            <div>
              <p role="alert">{room.gmStatus.message}</p>
              {room.gmStatus.canRetry && (
                <button type="button" onClick={() => conn.current?.sendRetry()}>
                  ลองใหม่
                </button>
              )}
            </div>
          )}
          {you.place && <p>คุณอยู่ที่: {you.place.name}</p>}
          {you.drowsy && <p role="note">คุณง่วงซึม (Drowsy) ทั้งวันนี้: ทอย d20 -2 และทุก action เสีย Stamina เพิ่ม 1</p>}
          {room.phase === 'NOCTHERION' && you.role === 'player' && (
            <p>ช่วง NOCTHERION: ส่ง Secret ได้ฟรี 1 เทิร์น และควรนอน (REST / SLEEP) อย่างน้อย 1 เทิร์น ไม่อย่างนั้นวันถัดไปจะง่วงซึม</p>
          )}

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
                  ส่งแล้ว ({you.action.visibility === 'secret' ? 'Secret' : 'Public'}
                  {you.action.rest ? ' · REST / SLEEP' : ''}): {you.action.text}
                  {room.status === 'collecting' && <small> (ส่งใหม่เพื่อแทนของเดิมได้จนกว่าเทิร์นจะปิด)</small>}
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
                    disabled={you.secretUsed}
                    onChange={() => setVisibility('secret')}
                  />
                  Secret (เห็นคนเดียว ได้วันละ 1 เทิร์น + ฟรี 1 เทิร์นในช่วง NOCTHERION
                  {you.secretUsed ? (room.phase === 'NOCTHERION' ? ' · คืนนี้ใช้แล้ว' : ' · วันนี้ใช้แล้ว') : ''})
                </label>
              </fieldset>
              <label>
                <input type="checkbox" checked={rest} disabled={locked} onChange={(e) => setRest(e.target.checked)} />
                REST / SLEEP (พักหรือนอนในเทิร์นนี้ แทนการลงมือทำ)
              </label>
              <button type="submit" disabled={locked || waitingReply}>
                {you.action ? 'ส่งแทนของเดิม' : 'ส่ง action'}
              </button>
              {problem && <p role="alert">{problem}</p>}
            </form>
          )}

          {/* GEN-058: the Human GM's console; reloads whenever the turn or the GM status moves. */}
          {you.role === 'gm' && (
            <GmConsole
              apiBaseUrl={apiBaseUrl}
              token={token}
              refreshKey={`${room.day}-${room.phase}-${room.turn}-${room.status}-${room.gmStatus?.code ?? ''}`}
            />
          )}

          <EntryList label="เหตุการณ์ที่นี่" entries={feed} empty="ยังไม่มีอะไรเกิดขึ้นที่นี่" />
          <EntryList label="สิ่งที่คุณรู้คนเดียว" entries={narration} empty="ยังไม่มี" />

          <section aria-label="Whisper">
            <h3>Whisper</h3>
            {you.role === 'player' &&
              (allies.length === 0 ? (
                <p>ยังไม่มีพันธมิตรที่สนิทพอจะ Whisper ได้</p>
              ) : (
                <form aria-label="ส่ง Whisper" onSubmit={(e) => sendWhisper(e, allies[0]!.ref)}>
                  <label>
                    ถึง
                    <select value={whisperTo || allies[0]!.ref} onChange={(e) => setWhisperTo(e.target.value)}>
                      {allies.map((a) => (
                        <option key={a.ref} value={a.ref}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    ข้อความ Whisper
                    <textarea value={whisperText} onChange={(e) => setWhisperText(e.target.value)} rows={2} />
                  </label>
                  <button type="submit">ส่ง Whisper</button>
                  {whisperProblem && <p role="alert">{whisperProblem}</p>}
                </form>
              ))}
            {whispers.length === 0 ? (
              <p>ยังไม่มี Whisper</p>
            ) : (
              <ol>
                {whispers.map((e) => (
                  <li key={e.seq}>
                    <small>{entryHeading(e)}</small>
                    <p>{e.whisper?.mine ? `ถึง ${e.whisper.to}: ${e.text}` : `จาก ${e.whisper?.from ?? ''}: ${e.text}`}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  );
}
