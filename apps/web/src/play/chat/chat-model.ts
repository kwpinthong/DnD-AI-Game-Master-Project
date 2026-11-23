import { PHASES, weatherText, type EntryVote, type Phase, type RollView, type RoomEntry, type RoomState, type TurnChange } from '@isekai/protocol';
import { playText } from '../../ui/strings.ts';

/** GEN-122: the pure rules of the chat-style Play page (what each entry looks like, the dial, the quick words). */

/** The word of each period (README: "— บ่าย · เทิร์น 1 · …"); the Latin names stay in the protocol. */
export const PERIOD_WORD: Readonly<Record<Phase, string>> = { EOSORIA: 'เช้า', SOLARION: 'บ่าย', HESPERION: 'ค่ำ', NOCTHERION: 'ดึก' };

/** The half-circle dial: 4 equal slots from left (-90deg = straight up is the middle, so slots are at -67.5 / -22.5 / 22.5 / 67.5). */
export const dialAngle = (phase: Phase): number => -67.5 + PHASES.indexOf(phase) * 45;

/** For screen readers: "วันที่ 2 จาก 12 ช่วงบ่าย เทิร์น 1 จาก 2 อากาศฝนตก". */
export function dialLabel(room: Pick<RoomState, 'day' | 'phase' | 'turn' | 'weather'>): string {
  const weather = room.weather ? weatherText(room.weather) : playText.weatherPending.replace(/^อากาศ: ?/, '');
  return `วันที่ ${room.day} จาก 12 ช่วง${PERIOD_WORD[room.phase]} เทิร์น ${room.turn} จาก 2 อากาศ${weather}`;
}

/** What a quick-action button writes in the box: the word, plus a space where a target comes next. */
export const QUICK_WORDS = ['พูดคุย', 'สังเกต', 'สืบค้น', 'โจมตี', 'ป้องกัน', 'สวด', 'ลอบเร้น', 'พัก'] as const;
export type QuickWord = (typeof QUICK_WORDS)[number];
const NEEDS_TARGET: readonly QuickWord[] = ['พูดคุย', 'โจมตี'];

/** A quick button only prefills: it replaces another quick word at the start, or goes in front of what is already typed. */
export function prefillAction(text: string, word: QuickWord): string {
  const had = QUICK_WORDS.find((w) => text === w || text.startsWith(`${w} `));
  const rest = (had ? text.slice(had.length) : text).trim();
  if (rest === '') return NEEDS_TARGET.includes(word) ? `${word} ` : word;
  return `${word} ${rest}`;
}

/** "ทอย 14 · สำเร็จ" */
export const rollBadge = (roll: RollView): string => `ทอย ${roll.d20} · ${playText.outcome[roll.outcome]}`;

export type BadgeTone = 'plain' | 'gain';
export interface ChangeBadge {
  text: string;
  tone: BadgeTone;
}

const STAT = playText.changes.stat;
/** One centre badge per changed value of a `changes` entry: "แรง −3 · เดินทางข้ามโซน"; coins gained are amber (GEN-114). */
export function changeBadges(changes: readonly TurnChange[]): ChangeBadge[] {
  return changes.map((c) => {
    const label = STAT[c.stat];
    const what = 'delta' in c ? `${label} ${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta)}` : c.stat === 'conduct' ? `${label} ${c.from} → ${c.to}` : c.stat === 'bond' ? `${label} ${c.name} ${c.from} → ${c.to}` : `${label}: ${c.name}`;
    return { text: `${what} · ${c.reason}`, tone: c.stat === 'coins' && c.delta > 0 ? 'gain' : 'plain' };
  });
}

/** "— บ่าย · เทิร์น 1 · น้ำพุกลางเมือง —"; the day is named only when it is not today. */
export function dividerText(entry: Pick<RoomEntry, 'day' | 'phase' | 'turn' | 'place'>, today: number | undefined): string {
  const parts = [entry.day === today || today === undefined ? null : `วันที่ ${entry.day}`, PERIOD_WORD[entry.phase], `เทิร์น ${entry.turn}`, entry.place?.name ?? null];
  return `— ${parts.filter((p): p is string => p !== null).join(' · ')} —`;
}

/** How one entry is drawn. `skip`: it has no place in the feed (a whisper lives in the people tab, a hit on the pinned card). */
export type EntryLook = 'narration' | 'npc-dialogue' | 'npc-reaction' | 'changes' | 'omen' | 'hit-line' | 'player-action' | 'time' | 'news' | 'skip';
export function entryLook(entry: Pick<RoomEntry, 'kind' | 'npc' | 'actor'>, hitAcknowledged = false): EntryLook {
  switch (entry.kind) {
    case 'player':
      return entry.actor ? 'player-action' : 'narration';
    case 'feed':
    case 'narration':
      return 'narration';
    case 'npc':
      return entry.npc?.kind === 'reaction' ? 'npc-reaction' : entry.npc ? 'npc-dialogue' : 'narration';
    case 'changes':
      return 'changes';
    case 'omen':
      return 'omen';
    case 'hit':
      return hitAcknowledged ? 'hit-line' : 'skip';
    case 'whisper':
      return 'skip';
    case 'news':
      return 'news';
    case 'time':
      return 'time';
  }
}

/** The vote the player sees: the pending local one wins over what the entry came with. */
export const shownVote = (entry: Pick<RoomEntry, 'seq' | 'myVote'>, local: ReadonlyMap<number, EntryVote | null>): EntryVote | null | undefined =>
  local.has(entry.seq) ? local.get(entry.seq)! : entry.myVote;
