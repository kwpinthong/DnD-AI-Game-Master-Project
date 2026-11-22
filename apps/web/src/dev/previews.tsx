import { LearningLibraryResponse, type GameLogResponse, type HitChange, type RoomEntry } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { GameLog } from '../GameHistory.tsx';
import { fetchGameLog } from '../history-api.ts';
import { connectRoom, type RoomConnectionStatus } from '../room-api.ts';
import { apiUrl, fetchWithTimeout } from '../session.ts';
import { EmptyState, ErrorState, HitCard, Skeleton } from '../ui/index.ts';

/**
 * Dev gallery stand-ins (GEN-100) for contract screens that have data but no page yet. Each one is the
 * smallest view of its payload built from the existing clients (room-api, history-api) and the theme's
 * base components; the real screens replace them (GEN-088..091).
 */

const CONNECTION: Record<RoomConnectionStatus, string> = {
  connecting: 'กำลังเชื่อมต่อห้อง…',
  online: 'เชื่อมต่อแล้ว',
  reconnecting: 'หลุดการเชื่อมต่อ กำลังต่อใหม่…',
  closed: 'ปิดการเชื่อมต่อแล้ว',
};

const STAT: Record<HitChange['stat'], string> = {
  hp: 'HP',
  stamina: 'แรง',
  coins: 'เหรียญ',
  item_lost: 'ของที่หาย',
  skill_lost: 'ความสามารถที่เสีย',
  status: 'สถานะ',
};

function changeText(change: HitChange): string {
  if ('delta' in change) return `${STAT[change.stat]} ${change.delta > 0 ? '+' : ''}${change.delta}`;
  return `${STAT[change.stat]}: ${change.name}`;
}

/** 4.5 the pinned "เกิดกับคุณ" cards, live from the room socket. */
export function HitPreview({ apiBaseUrl, token }: { apiBaseUrl: string; token: string }) {
  const [status, setStatus] = useState<RoomConnectionStatus>('connecting');
  const [hits, setHits] = useState<RoomEntry[]>([]);
  useEffect(() => {
    const c = connectRoom(apiBaseUrl, token, {
      status: setStatus,
      room: () => {},
      entry: (e) => {
        if (e.kind === 'hit') setHits((list) => [...list, e]);
      },
      actionReply: () => {},
      whisperReply: () => {},
      fatal: () => {},
    });
    return () => c.close();
  }, [apiBaseUrl, token]);
  return (
    <div className="preview">
      <p role="status">{CONNECTION[status]}</p>
      {hits.length === 0 ? (
        <EmptyState title="ยังไม่มีอะไรเกิดกับคุณ">การ์ดจะปักไว้ที่นี่เมื่อผู้เล่นอื่นทำอะไรกับคุณ</EmptyState>
      ) : (
        hits.map((e) => (
          <HitCard key={e.seq} actor={e.hit?.actor ?? null} onAcknowledge={() => setHits((list) => list.filter((h) => h.seq !== e.seq))}>
            {e.text}
            {e.hit && e.hit.changes.length > 0 && <span className="preview__changes">{e.hit.changes.map(changeText).join(' / ')}</span>}
          </HitCard>
        ))
      )}
    </div>
  );
}

/** 6. the end: the game log with everyone's secrets (GameHistory's read-only view). */
export function EndingPreview({ apiBaseUrl, token }: { apiBaseUrl: string; token: string }) {
  const [log, setLog] = useState<GameLogResponse | 'unreachable' | null>();
  useEffect(() => {
    let live = true;
    void fetchGameLog(apiBaseUrl, token).then((l) => live && setLog(l));
    return () => {
      live = false;
    };
  }, [apiBaseUrl, token]);
  if (log === undefined) return <Skeleton />;
  if (log === null || log === 'unreachable') return <ErrorState message="โหลดสรุปเกมไม่ได้" />;
  return <GameLog log={log} onBack={() => {}} />;
}

type Library = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: LearningLibraryResponse };

/** 7. the learning library (server owner): loading, error, empty or the entries. */
export function LibraryPreview({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [library, setLibrary] = useState<Library>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    fetchWithTimeout(apiUrl(apiBaseUrl, '/api/admin/learning'), { headers: { authorization: 'Bearer admin' } })
      .then(async (res) => {
        const parsed = LearningLibraryResponse.safeParse(await res.json());
        if (live) setLibrary(res.ok && parsed.success ? { state: 'ready', data: parsed.data } : { state: 'error' });
      })
      .catch(() => live && setLibrary({ state: 'error' }));
    return () => {
      live = false;
    };
  }, [apiBaseUrl]);
  if (library.state === 'loading') return <Skeleton />;
  if (library.state === 'error') return <ErrorState message="ติดต่อ server ไม่ได้ เปิด library ไม่ได้ตอนนี้" />;
  if (library.data.entries.length === 0) {
    return <EmptyState title="ยังไม่มีความรู้ใน library">เกมที่จบแล้วและได้คะแนนดีจะเพิ่มความรู้มาที่นี่</EmptyState>;
  }
  return (
    <ul className="preview preview__list">
      {library.data.entries.map((e) => (
        <li key={e.id}>
          <strong>{e.type}</strong> {e.content}
          <small> ({e.sourceGameName}{e.status === 'suspended' ? ', พักไว้' : ''})</small>
        </li>
      ))}
    </ul>
  );
}
