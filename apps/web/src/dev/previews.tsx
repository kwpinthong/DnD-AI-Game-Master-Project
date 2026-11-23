import type { RoomState } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { GmConsole } from '../GmConsole.tsx';
import { connectRoom } from '../room-api.ts';
import { Button } from '../ui/Button.tsx';
import { FeedbackDialog } from '../ui/FeedbackDialog.tsx';
import { feedbackText } from '../ui/strings.ts';

/**
 * Dev gallery frames (GEN-100). The hit card (GEN-088), the end page and the Learning library (GEN-091) are
 * the real screens now (Q-253): see screens.tsx. Only the GM console frame is left here.
 */

/** ISK-011: the report box open with a draft; the frame's scenario decides how ส่ง ends. Closed, a button opens it again. */
export function FeedbackFrame({ apiBaseUrl, token }: { apiBaseUrl: string; token: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="preview">
      {!open && <Button onClick={() => setOpen(true)}>{feedbackText.open}</Button>}
      <FeedbackDialog apiBaseUrl={apiBaseUrl} token={token} page="play" open={open} onClose={() => setOpen(false)} initialText="ปุ่มส่ง action ค้างตอนเน็ตช้า ต้องรีเฟรชหน้า" />
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
