// ISK-013: a clue entry (RoomEntry.clue) is a light-purple box (token --clue) with a magnifier icon and the word "เบาะแส".
import type { GameLogResponse, RoomEntry } from '@isekai/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GameLog } from '../src/GameHistory.tsx';
import { entryLook } from '../src/play/chat/chat-model.ts';
import { ChatFeed } from '../src/play/chat/ChatFeed.tsx';
import { contrast, textPairs } from './contrast.ts';

afterEach(cleanup);

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (path: string) => readFileSync(join(src, path), 'utf8').replace(/\r\n/g, '\n');
const rule = (css: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
const tokens = Object.fromEntries([...read('tokens.css').matchAll(/(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));

const at = { day: 1, phase: 'EOSORIA', turn: 2 } as const;
const CLUE_TEXT = 'พบร่องรอยลับที่ลานตลาด ซึ่งมีคนทิ้งไว้ในวันที่ 1';
const clue: RoomEntry = { seq: 31, kind: 'narration', ...at, place: null, text: CLUE_TEXT, clue: true };
const story: RoomEntry = { seq: 30, kind: 'narration', ...at, place: null, text: 'คุณก้มลงมองรอยงัดที่กล่องเงิน', myVote: null };
const voting = { local: new Map(), busy: new Set<number>(), onVote: () => {} };

const feed = (entries: RoomEntry[]) => render(<ChatFeed entries={entries} day={1} placeId="market" placeName="ลานตลาด" astral={false} voting={voting} />);
const clueBox = () => screen.getByText(CLUE_TEXT).closest('.chat-clue');

describe('ISK-013 the clue entry in the feed', () => {
  it('C2: has its own look; a box with the magnifier icon and the word เบาะแส, no vote buttons', () => {
    expect(entryLook(clue)).toBe('clue');
    feed([story, clue]);
    const box = clueBox();
    expect(box).toBeTruthy();
    expect(box!.textContent).toContain('เบาะแส');
    expect(box!.querySelector('.icon[aria-hidden="true"]')).toBeTruthy();
    expect(box!.closest('li')!.querySelector('.vote-buttons')).toBeNull();
    expect(box!.closest('.chat-narration')).toBeNull();
  });

  it('C2 + C8: styled from the --clue token only (border + text), wraps at 390px', () => {
    const chat = read('play/chat/chat.css');
    const box = rule(chat, '.chat-clue');
    expect(box).toMatch(/border[^;]*var\(--clue\)/);
    expect(box).toMatch(/(?:^|[;\s])color:\s*var\(--clue\)/);
    expect(box).toMatch(/background:\s*var\(--/);
    expect(box).toMatch(/overflow-wrap:\s*anywhere/);
    expect(box).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(box).not.toMatch(/(^|[^-])width:\s*\d/);
    expect(box).not.toMatch(/min-width:\s*\d/);
  });

  it('C3: --clue is light purple and >= 4.5:1 on --page, --panel and --bg (and those pairs are checked)', () => {
    expect(tokens['--clue']).toBeDefined();
    for (const bg of ['--page', '--panel', '--bg']) {
      expect(contrast(tokens['--clue']!, tokens[bg]!), `--clue on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(textPairs.some(([fg, b]) => fg === '--clue' && b === bg), `--clue|${bg} in contrast.ts`).toBe(true);
    }
  });

  it('C4 + C6: a plain narration (no clue key, as old entries are) keeps the narration look, no error', () => {
    expect(entryLook(story)).toBe('narration');
    feed([story]);
    const line = screen.getByText(story.text);
    expect(line.closest('.chat-narration')).toBeTruthy();
    expect(line.closest('.chat-clue')).toBeNull();
    expect(document.querySelector('.chat-clue')).toBeNull();
    expect(screen.queryByText('เบาะแส')).toBeNull();
  });

  it('C5 + C7: a clue that arrived live is drawn whole as a clue at once; the same entry from a replay looks the same', () => {
    feed([story, clue]);
    const replayed = clueBox()!.outerHTML;
    cleanup();
    render(<ChatFeed entries={[story, clue]} day={1} placeId="market" placeName="ลานตลาด" astral={false} voting={voting} live={new Map([[clue.seq, Date.now()]])} />);
    expect(clueBox()!.outerHTML).toBe(replayed);
  });

  it('C8: the screen reader reads เบาะแส; the icon is hidden from it', () => {
    feed([clue]);
    const box = clueBox()!;
    const label = box.querySelector('.chat-clue-title')!;
    expect(label.textContent).toBe('เบาะแส');
    for (const icon of box.querySelectorAll('.icon, svg')) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('C5: the game log (history) marks the clue with the word เบาะแส and the clue look', () => {
    const log = {
      game: { id: 'g', name: 'เกมทดสอบ', mode: 'online', humanGm: false, status: 'playing', endReason: null, at: { day: 1, phase: 'SOLARION', turn: 1 }, startedAt: '2026-11-01T12:00:00.000Z' },
      you: { memberId: 'm', role: 'player' },
      members: [],
      timeline: { view: 'player', at: { day: 1, phase: 'SOLARION' }, ended: false, events: [] },
      entries: [story, clue],
      reveal: null,
    } as unknown as GameLogResponse;
    render(<GameLog log={log} onBack={() => {}} />);
    const item = screen.getByText(CLUE_TEXT, { exact: false }).closest('li')!;
    expect(item.classList.contains('history-clue')).toBe(true);
    expect(item.textContent).toContain('เบาะแส');
    expect(screen.getByText(story.text, { exact: false }).closest('li')!.classList.contains('history-clue')).toBe(false);
  });
});
