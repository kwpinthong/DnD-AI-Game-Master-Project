// GEN-145 C7: the period-change announcement is a centred line in the feed, not a chat bubble or a narration.
import type { RoomEntry } from '@isekai/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatFeed } from '../src/play/chat/ChatFeed.tsx';

afterEach(cleanup);

const base = { day: 1, phase: 'HESPERION', turn: 1 } as const;
const announce: RoomEntry = { ...base, seq: 10, kind: 'time', place: null, text: 'ระฆังหอคอยดังกังวานไปทั่วเมือง บัดนี้เข้าสู่ช่วง HESPERION (ค่ำ 18:00-23:59) แล้ว' };
const scene: RoomEntry = { ...base, seq: 11, kind: 'feed', place: { id: 'fountain', name: 'น้ำพุกลางเมือง' }, text: 'แสงตะเกียงเริ่มจุดรอบน้ำพุ', myVote: null };

describe('GEN-145 C7 the time announcement in the feed', () => {
  it('is a centred line with no box, avatar, tag or votes; the scene after it is a narration', () => {
    render(<ChatFeed entries={[scene, announce]} day={1} placeId="fountain" placeName="น้ำพุกลางเมือง" astral={false} voting={{ local: new Map(), busy: new Set(), onVote: () => {} }} />);
    const line = screen.getByText(announce.text);
    expect(line.closest('.chat-time')).toBeTruthy();
    expect(line.closest('.chat-narration')).toBeNull();
    expect(line.closest('.chat-row')).toBeNull();
    expect(line.closest('.chat-box')).toBeNull();
    expect(line.closest('li')!.querySelector('.vote-buttons')).toBeNull();
    // Before the scene, whatever order the entries came in.
    const items = [...document.querySelectorAll('.chat-item')].map((li) => li.textContent ?? '');
    expect(items.findIndex((t) => t.includes(announce.text))).toBeLessThan(items.findIndex((t) => t.includes(scene.text)));
    expect(screen.getByText(scene.text).closest('.chat-narration')).toBeTruthy();
  });

  it('is centred and coloured from tokens.css only', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, '..', 'src', 'play', 'chat', 'chat.css'), 'utf8').replace(/\r\n/g, '\n');
    const body = /\.chat-time\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toMatch(/text-align:\s*center/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(body).toMatch(/color:\s*var\(--/);
  });
});
