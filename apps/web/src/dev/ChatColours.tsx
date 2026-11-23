import { useState } from 'react';
import '../play/chat/chat.css';
import '../play/chat/art.css';
import { ChatFeed } from '../play/chat/ChatFeed.tsx';
import { PlayerBubble } from '../play/chat/Bubbles.tsx';
import { scenarioById } from '../mock/scenarios.ts';
import type { EntryVote } from '@isekai/protocol';

/**
 * /dev/chat-colours (GEN-142, dev + VITE_MOCK=1 only): one page with every chat piece the colour check against
 * docs/design/ui-v3-chat needs. The feed is the real ChatFeed on the `chat-colours` scenario (NPC box, gain badge,
 * vote buttons, our own box). The contract has no entry kind for another player's action yet (GEN-129, server),
 * so the PlayerBubble is drawn from its own props under the feed.
 */
export function ChatColours() {
  const s = scenarioById('chat-colours');
  const [local, setLocal] = useState(new Map<number, EntryVote | null>());
  return (
    // `.play` scopes the chat rules (vote buttons); its fixed height and clipping are for the real room, not this page.
    <div className="play chat-colours" style={{ display: 'flex', flexDirection: 'column', height: 'auto', minHeight: '100vh', overflow: 'visible' }}>
      <ChatFeed
        entries={s.room.entries}
        day={s.room.state.day}
        placeId={s.room.state.you.place?.id ?? null}
        astral={false}
        ownAction={{ text: 'เล่นพิณเพลงพื้นบ้านจากบ้านเกิด', visibility: 'public', rest: false }}
        voting={{ local, busy: new Set(), onVote: (e, next) => setLocal(new Map(local).set(e.seq, next)) }}
      />
      <ol className="chat-list" style={{ maxWidth: 900, margin: '0 auto', width: '100%', listStyle: 'none', padding: '0 16px' }}>
        <li className="chat-item">
          <PlayerBubble alias="ผู้มาเยือนเสื้อคลุมแดง" text="โยนเหรียญลงในหมวกของคุณ แล้วเดินจากไป" />
        </li>
      </ol>
    </div>
  );
}
