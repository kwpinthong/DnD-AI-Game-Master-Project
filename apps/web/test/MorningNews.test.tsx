// ISK-014 C7: the morning news is its own box in the feed (heading "ข่าวเช้าวันที่ N", scroll icon, token colours), no votes.
import type { RoomEntry } from '@isekai/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { entryLook } from '../src/play/chat/chat-model.ts';
import { ChatFeed } from '../src/play/chat/ChatFeed.tsx';

afterEach(cleanup);

const base = { day: 3, phase: 'EOSORIA', turn: 1 } as const;
const announce: RoomEntry = { ...base, seq: 10, kind: 'time', place: null, text: 'รุ่งเช้าวันที่ 3 มาถึงแล้ว' };
const news: RoomEntry = { ...base, seq: 11, kind: 'news', place: null, text: 'งานเทศกาลโคมไฟลอยฟ้าเริ่มขึ้นที่ลานน้ำพุ\nข่าวลือว่าแม่ชีผู้เหนื่อยล้าไม่ได้นอนทั้งคืน' };
const scene: RoomEntry = { ...base, seq: 12, kind: 'feed', place: { id: 'fountain', name: 'น้ำพุกลางเมือง' }, text: 'แสงแดดอ่อนส่องลงบนน้ำพุ', myVote: null };
const evidence: RoomEntry = { ...base, seq: 13, kind: 'narration', place: null, text: 'พบร่องรอยลับ (หลักฐาน e1)', myVote: null };

const css = () => {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', 'src', 'play', 'chat', 'chat.css'), 'utf8').replace(/\r\n/g, '\n');
};
const rule = (selector: string) => new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css())?.[1] ?? '';

describe('ISK-014 C7 the morning news in the feed', () => {
  it('has its own look', () => {
    expect(entryLook({ kind: 'news' })).toBe('news');
  });

  it('is a box headed "ข่าวเช้าวันที่ 3" with one line per item and a scroll icon, no vote buttons, after the time line and before the scene', () => {
    render(<ChatFeed entries={[scene, evidence, news, announce]} day={3} placeId="fountain" placeName="น้ำพุกลางเมือง" astral={false} voting={{ local: new Map(), busy: new Set(), onVote: () => {} }} />);
    const box = screen.getByRole('region', { name: 'ข่าวเช้าวันที่ 3' });
    expect(box.classList.contains('chat-news')).toBe(true);
    expect(within(box).getByText('ข่าวเช้าวันที่ 3')).toBeTruthy();
    expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual(news.text.split('\n'));
    expect(box.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(box.closest('li')!.querySelector('.vote-buttons')).toBeNull();
    // Not drawn like a narration, a clue or the time line.
    expect(box.closest('.chat-narration')).toBeNull();
    expect(box.closest('.chat-time')).toBeNull();
    const items = [...document.querySelectorAll('ol.chat-list > .chat-item')].map((li) => li.textContent ?? '');
    const where = (text: string) => items.findIndex((t) => t.includes(text));
    expect(where(announce.text)).toBeLessThan(where('ข่าวเช้าวันที่ 3'));
    expect(where('ข่าวเช้าวันที่ 3')).toBeLessThan(where(scene.text));
  });

  it('is styled from tokens only and wraps inside a 390px phone (no fixed width, long words break)', () => {
    for (const selector of ['.chat-news', '.chat-news-title']) {
      const body = rule(selector);
      expect(body, selector).not.toBe('');
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
    const box = rule('.chat-news');
    expect(box).toMatch(/border[^;]*var\(--/);
    expect(box).toMatch(/background:\s*var\(--/);
    expect(box).toMatch(/overflow-wrap:\s*anywhere/);
    expect(box).not.toMatch(/(^|[^-])width:\s*\d/);
    expect(box).not.toMatch(/min-width:\s*\d/);
  });
});
