import type { RoomEntry } from '@isekai/protocol';
import { useSyncExternalStore } from 'react';

/**
 * GEN-148: the chat feel without AI token streaming. The server sends each entry once, final: masked per viewer by
 * the name filter (GEN-121 / GEN-154) and passed by the style check (GEN-169). The client only reveals that final text
 * piece by piece, so no frame can show more than the saved entry, and a reconnect has nothing half-sent to repair.
 */

/** How long an NPC "types" before its line starts. */
export const TYPING_MS = 700;
/** One grapheme every 25 ms (40 per second), and no entry takes longer than MAX_REVEAL_MS. */
export const MS_PER_GRAPHEME = 25;
export const MAX_REVEAL_MS = 3_000;
/** shortcut: the client guesses the dialogue stage runs after our narration; a turn with no NPC line shows "กำลังพิมพ์" until this. Upgrade to a server signal if that bothers players. */
export const WAIT_DIALOGUE_MS = 20_000;
/** Colour slots --npc-1 … --npc-6 in tokens.css. */
export const NPC_SLOTS = 6;
const BUBBLE_MAX = 70;

const segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' });
/** Thai vowels and tone marks stay on their letter: never cut a cluster in half. */
export const graphemes = (text: string): string[] => [...segmenter.segment(text)].map((s) => s.segment);

/** An NPC line as short bubbles: one per line / sentence, a long one cut at a space; joined with spaces it is the text. */
export function splitBubbles(text: string, max = BUBBLE_MAX): string[] {
  const out: string[] = [];
  for (const part of text.split(/\n+|(?<=[.!?…])\s+/)) {
    let rest = part.trim();
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max);
      if (cut < max / 3) break;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out.length > 0 ? out : [text];
}

export interface Reveal {
  /** When the NPC starts "typing" (= `from` for narration), when the text starts, when it is whole. */
  typingFrom: number;
  from: number;
  to: number;
  total: number;
}

/** Live entries one after another in seq order: a batch of lines comes out like a conversation, not all at once. */
export function revealPlan(items: readonly { seq: number; at: number; text: string; typing: boolean }[]): Map<number, Reveal> {
  const plan = new Map<number, Reveal>();
  let free = 0;
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    const total = graphemes(item.text.replace(/\s+/g, '')).length;
    const typingFrom = Math.max(item.at, free);
    const from = typingFrom + (item.typing ? TYPING_MS : 0);
    const to = from + Math.min(MAX_REVEAL_MS, total * MS_PER_GRAPHEME);
    plan.set(item.seq, { typingFrom, from, to, total });
    free = to;
  }
  return plan;
}

export type RevealPhase = 'queued' | 'typing' | 'streaming' | 'done';
export const revealPhase = (r: Reveal | undefined, now: number): RevealPhase =>
  !r || now >= r.to ? 'done' : now < r.typingFrom ? 'queued' : now < r.from ? 'typing' : 'streaming';

/** The visible part of each bubble when `share` (0…1) of the graphemes are out; spaces are free, empty bubbles dropped. */
export function revealBubbles(bubbles: readonly string[], share: number): string[] {
  const parts = bubbles.map(graphemes);
  let left = Math.floor(share * parts.reduce((n, p) => n + p.filter((g) => !/^\s+$/.test(g)).length, 0));
  const out: string[] = [];
  for (const p of parts) {
    if (left <= 0) break;
    let i = 0;
    for (; i < p.length && left > 0; i++) if (!/^\s+$/.test(p[i]!)) left--;
    out.push(p.slice(0, i).join(''));
  }
  return out;
}

export const revealShare = (r: Reveal | undefined, now: number): number => (!r || now >= r.to ? 1 : now <= r.from ? 0 : (now - r.from) / (r.to - r.from));

/** ref → colour slot 1…NPC_SLOTS, in the order the NPCs first spoke in this feed (two NPCs never share one until 7). */
export function npcSlots(entries: readonly Pick<RoomEntry, 'seq' | 'npc'>[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) if (e.npc && !slots.has(e.npc.ref)) slots.set(e.npc.ref, (slots.size % NPC_SLOTS) + 1);
  return slots;
}

/** True while the dialogue stage (GEN-116) may still be writing: our narration came in live, no NPC line after it yet. */
export function awaitingDialogue(entries: readonly Pick<RoomEntry, 'seq' | 'kind'>[], live: ReadonlyMap<number, number>, now: number): boolean {
  const last = entries.filter((e) => e.kind === 'narration' && live.has(e.seq)).sort((a, b) => b.seq - a.seq)[0];
  if (!last || now - live.get(last.seq)! >= WAIT_DIALOGUE_MS) return false;
  return !entries.some((e) => e.kind === 'npc' && e.seq > last.seq);
}

const REDUCE = '(prefers-reduced-motion: reduce)';
const media = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE) : null);
function subscribe(onChange: () => void) {
  const m = media();
  m?.addEventListener?.('change', onChange);
  return () => m?.removeEventListener?.('change', onChange);
}
/** True when the reader asked for less motion; also without `matchMedia` (tests, old browsers): no motion is the safe side. */
export const useReducedMotion = (): boolean => useSyncExternalStore(subscribe, () => media()?.matches ?? true, () => true);
