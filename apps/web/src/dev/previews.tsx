import type { HitChange, RoomEntry, RoomState } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { GmConsole } from '../GmConsole.tsx';
import { connectRoom, type RoomConnectionStatus } from '../room-api.ts';
import { EmptyState, HitCard } from '../ui/index.ts';

/**
 * Dev gallery stand-ins (GEN-100) for contract screens that have data but no page yet. Each one is the
 * smallest view of its payload built from the existing clients (room-api) and the theme's base components;
 * the real screens replace them (GEN-088..091). The end page and the Learning library are the real screens
 * now (GEN-091, Q-253): see screens.tsx.
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

/**
 * 5. the GM console as the play room mounts it: the room socket gives it the AI GM status (Q-221) and tells
 * it when the turn moved. The console itself is the real screen (GEN-091).
 */
export function GmConsoleFrame({ apiBaseUrl, token }: { apiBaseUrl: string; token: string }) {
  const [room, setRoom] = useState<RoomState | null>(null);
  useEffect(() => {
    const c = connectRoom(apiBaseUrl, token, { status: () => {}, room: setRoom, entry: () => {}, actionReply: () => {}, whisperReply: () => {}, fatal: () => {} });
    return () => c.close();
  }, [apiBaseUrl, token]);
  return (
    <GmConsole
      apiBaseUrl={apiBaseUrl}
      token={token}
      refreshKey={room ? `${room.day}-${room.phase}-${room.turn}-${room.status}-${room.gmStatus?.code ?? ''}` : 'mock'}
      gmStatus={room?.gmStatus ?? null}
    />
  );
}
