// GEN-148: the chat feels like a chat. No AI token streaming: the client reveals the FINAL entry it was sent (already
// masked per viewer by the name filter and passed by the style check) piece by piece, an NPC "types" first, the waiting
// for the dialogue stage shows "กำลังพิมพ์…", NPC lines are short bubbles and each NPC gets its own token colour.
import type { RoomEntry } from '@isekai/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFeed } from '../src/play/chat/ChatFeed.tsx';
import { NPC_SLOTS, TYPING_MS, WAIT_DIALOGUE_MS, awaitingDialogue, npcSlots, splitBubbles } from '../src/play/chat/stream.ts';
import { contrast } from './contrast.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (path: string) => readFileSync(join(src, path), 'utf8').replace(/\r\n/g, '\n');

const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;
const market = { id: 'market', name: 'ลานตลาด' };
const narration = (seq: number, text: string): RoomEntry => ({ seq, kind: 'narration', ...at, place: null, text });
const npcLine = (seq: number, ref: string, name: string, text: string): RoomEntry => ({ seq, kind: 'npc', ...at, place: market, text, npc: { ref, name, kind: 'dialogue' } });

const LONG = 'เจ้ามาทันเวลาพอดี ข้ารออยู่ตั้งนานแล้ว! วันนี้ตลาดวุ่นวายกว่าทุกวัน มีคนแปลกหน้าเดินผ่านมาสามคน. ระวังตัวไว้ให้ดีนะ เพราะคืนนี้จันทร์จะเป็นสีเลือด';

function motion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }));
}

function feed(entries: RoomEntry[], live: ReadonlyMap<number, number>) {
  return <ChatFeed entries={entries} placeId="market" placeName="ลานตลาด" astral={false} live={live} />;
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const npcText = (container: HTMLElement) => [...container.querySelectorAll('.chat-box--npc:not(.chat-typing)')].map((b) => b.textContent ?? '');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  motion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GEN-148 pure rules', () => {
  it('C2 an NPC line becomes short bubbles that put back together are the saved text', () => {
    const bubbles = splitBubbles(LONG);
    expect(bubbles.length).toBeGreaterThan(1);
    for (const b of bubbles) expect([...b].length).toBeLessThanOrEqual(70);
    expect(norm(bubbles.join(' '))).toBe(norm(LONG));
    expect(splitBubbles('สั้น ๆ')).toEqual(['สั้น ๆ']);
    expect(splitBubbles('บรรทัดหนึ่ง\nบรรทัดสอง')).toEqual(['บรรทัดหนึ่ง', 'บรรทัดสอง']);
  });

  it('C1 waiting for the dialogue: after our narration arrives live, until an NPC line or the timeout', () => {
    const n = narration(4, 'คุณเดินไปที่แผงขนมปัง');
    const live = new Map([[4, 1_000]]);
    expect(awaitingDialogue([n], live, 1_500)).toBe(true);
    expect(awaitingDialogue([n], live, 1_000 + WAIT_DIALOGUE_MS)).toBe(false);
    expect(awaitingDialogue([n, npcLine(5, 'n-noa', 'โนอา', 'สวัสดี')], live, 1_500)).toBe(false);
    // history that came with the page (not live) waits for nothing
    expect(awaitingDialogue([n], new Map(), 1_500)).toBe(false);
  });

  it('C4 two NPCs get two different colour slots, in the order they first spoke', () => {
    const slots = npcSlots([npcLine(1, 'n-noa', 'โนอา', 'ก'), npcLine(2, 'n-bram', 'แบรม', 'ข'), npcLine(3, 'n-noa', 'โนอา', 'ค')]);
    expect(slots.get('n-noa')).toBe(1);
    expect(slots.get('n-bram')).toBe(2);
  });

  it('C4 every NPC colour token reads at >= 4.5:1 as a name on the feed / box and under the avatar letter', () => {
    const tokens = Object.fromEntries([...read('tokens.css').matchAll(/(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
    for (let n = 1; n <= NPC_SLOTS; n++) {
      const c = tokens[`--npc-${n}`];
      expect(c, `--npc-${n}`).toBeDefined();
      for (const bg of ['--bg', '--panel', '--bubble-npc']) expect(contrast(c!, tokens[bg]!), `--npc-${n} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['--on-accent']!, c!), `--on-accent on --npc-${n}`).toBeGreaterThanOrEqual(4.5);
    }
    const css = read('play/chat/chat.css');
    for (let n = 1; n <= NPC_SLOTS; n++) {
      expect(css).toContain(`.chat-avatar--npc-${n}`);
      expect(css).toMatch(new RegExp(`--npc-slot:\\s*var\\(--npc-${n}\\)`));
    }
  });
});

describe('GEN-148 the feed', () => {
  it('C1 shows "กำลังพิมพ์" after our narration, then at the avatar of the NPC about to speak, then the line', () => {
    const n = narration(4, 'คุณเดินไปที่แผงขนมปัง');
    const live = new Map([[4, 0]]);
    const { rerender } = render(feed([n], live));
    advance(2_000);
    expect(screen.getByRole('status', { name: 'กำลังพิมพ์…' })).toBeTruthy();

    live.set(5, Date.now());
    rerender(feed([n, npcLine(5, 'n-noa', 'โนอา', 'มาแล้วเหรอ')], live));
    advance(100);
    expect(screen.queryByRole('status', { name: 'กำลังพิมพ์…' })).toBeNull();
    expect(screen.getByRole('status', { name: 'โนอา กำลังพิมพ์…' })).toBeTruthy();
    advance(TYPING_MS + 2_000);
    expect(screen.queryByRole('status', { name: /กำลังพิมพ์/ })).toBeNull();
    expect(screen.getByText('มาแล้วเหรอ')).toBeTruthy();
  });

  it('C1 no NPC line: the indicator goes away at the timeout', () => {
    render(feed([narration(4, 'คุณยืนรอ')], new Map([[4, 0]])));
    advance(1_000);
    expect(screen.getByRole('status', { name: 'กำลังพิมพ์…' })).toBeTruthy();
    advance(WAIT_DIALOGUE_MS);
    expect(screen.queryByRole('status', { name: /กำลังพิมพ์/ })).toBeNull();
  });

  it('C2 a live line appears piece by piece and ends equal to the saved entry; votes wait for the end', () => {
    const line = { ...npcLine(5, 'n-noa', 'โนอา', LONG), myVote: null };
    const { container } = render(<ChatFeed entries={[line]} placeId="market" astral={false} live={new Map([[5, 0]])} voting={{ local: new Map(), busy: new Set(), onVote: () => {} }} />);
    advance(TYPING_MS + 300);
    const part = npcText(container).join('');
    expect(part.length).toBeGreaterThan(0);
    expect(norm(LONG).replace(/ /g, '').startsWith(part.replace(/\s/g, ''))).toBe(true);
    expect(part.replace(/\s/g, '').length).toBeLessThan(LONG.replace(/\s/g, '').length);
    expect(screen.queryByRole('group', { name: /ให้คะแนน|ถูกใจ/ })).toBeNull();
    advance(10_000);
    expect(norm(npcText(container).join(' '))).toBe(norm(LONG));
    expect(npcText(container).length).toBeGreaterThan(1);
    expect(screen.getAllByRole('group', { name: /ให้คะแนน|ถูกใจ/ }).length).toBeGreaterThan(0);
  });

  it('C2 history (not live) is shown whole at once', () => {
    const { container } = render(feed([npcLine(5, 'n-noa', 'โนอา', LONG)], new Map()));
    expect(norm(npcText(container).join(' '))).toBe(norm(LONG));
  });

  it('C4 two NPCs: different avatar colour slot and name colour, each with its own letter', () => {
    const { container } = render(feed([npcLine(1, 'n-noa', 'โนอา', 'ก'), npcLine(2, 'n-bram', 'แบรม', 'ข')], new Map()));
    const avatars = [...container.querySelectorAll('.chat-avatar')];
    expect(avatars[0]!.className).toContain('chat-avatar--npc-1');
    expect(avatars[1]!.className).toContain('chat-avatar--npc-2');
    expect(avatars.map((a) => a.textContent)).toEqual(['โ', 'แ']);
    expect(container.querySelector('.chat-who--npc.chat-npc-1')).not.toBeNull();
    expect(container.querySelector('.chat-who--npc.chat-npc-2')).not.toBeNull();
  });

  it('C5 reduced motion: the line is whole at once, no NPC typing beat, the dots do not move', () => {
    motion(true);
    const { container } = render(feed([npcLine(5, 'n-noa', 'โนอา', LONG)], new Map([[5, 0]])));
    expect(norm(npcText(container).join(' '))).toBe(norm(LONG));
    expect(screen.queryByRole('status', { name: /โนอา กำลังพิมพ์/ })).toBeNull();
    expect(read('play/chat/chat.css')).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.chat-typing__dot[^{]*\{\s*animation: none;/);
  });

  it('C6 a line the name filter cut: no frame of the stream shows the cut part', () => {
    const masked = 'ชายผมแดงที่ไม่บอกชื่อยืนอยู่ข้างบ่อน้ำ เขาหันมามองคุณแล้วยิ้มอย่างมีเลศนัย';
    const { container } = render(feed([npcLine(5, 'n-x', 'ชายผมแดง', masked)], new Map([[5, 0]])));
    const flat = masked.replace(/\s/g, '');
    for (let t = 0; t < 6_000; t += 40) {
      advance(40);
      const shown = (container.textContent ?? '').replace(/\s/g, '');
      expect(shown).not.toContain('อาเรน');
      expect(flat.startsWith(npcText(container).join('').replace(/\s/g, ''))).toBe(true);
    }
    expect(norm(npcText(container).join(' '))).toBe(norm(masked));
  });
});
