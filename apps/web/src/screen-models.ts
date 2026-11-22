import { PHASES, weatherText, type BondView, type Phase, type RollOutcome, type RollView, type RoomEntry, type RoomState, type RoomViewLockCode } from '@isekai/protocol';
import { playText } from './ui/strings.ts';

/**
 * Screen view-models over the GEN-099 contract types: what the Play screen shows, computed from the payloads
 * only. Exhaustive over the contract's enums on purpose: a schema change the screens do not handle breaks
 * this file's typecheck before merge (GEN-099 C5).
 */

/** Where an entry goes (Screens and Flows v2 UI-I3): `place` = centre feed, `private` = your column, `pin` = the hit card. */
export type EntrySection = 'place' | 'private' | 'pin';

const SECTION: Record<RoomEntry['kind'], EntrySection> = {
  feed: 'place',
  narration: 'private',
  whisper: 'private',
  omen: 'private',
  hit: 'pin',
};
export const entrySection = (entry: Pick<RoomEntry, 'kind'>): EntrySection => SECTION[entry.kind];

export type TurnDot = 'done' | 'current' | 'todo';

export interface TopBar {
  day: string;
  periods: { phase: Phase; current: boolean; turns: TurnDot[] }[];
  weather: string;
  /** "ส่งแล้ว n/m" (F2, Q-195); null in Single mode. */
  submitted: string | null;
}

export function topBar(room: RoomState): TopBar {
  const now = PHASES.indexOf(room.phase);
  const periods = PHASES.map((phase, i) => ({
    phase,
    current: i === now,
    turns: [1, 2].map((turn): TurnDot => (i < now || (i === now && turn < room.turn) ? 'done' : i === now && turn === room.turn ? 'current' : 'todo')),
  }));
  const players = room.members.filter((m) => m.role === 'player').length;
  return {
    day: playText.day(room.day),
    periods,
    weather: room.weather ? weatherText(room.weather) : playText.weatherPending,
    submitted: room.mode === 'single' ? null : playText.submitted(room.submittedCount, players),
  };
}

const OUTCOME: Record<RollOutcome, string> = playText.outcome;
/** The short roll line under a narration (F5): "ทอย d20 = 14 · ยาก · สำเร็จ". No DC, total or modifier exists to show. */
export const rollLine = (roll: RollView): string => playText.roll(roll.d20, roll.difficulty, OUTCOME[roll.outcome]);

/** The 6-cell companion bar (F4): filled up to the bond's step. */
export const bondBar = (bond: BondView): boolean[] => Array.from({ length: 6 }, (_, i) => i < bond.step);

const LOCK: Record<RoomViewLockCode, string> = playText.lock;
/** The title of the action box's lock state (4b–4h). */
export const lockTitle = (code: RoomViewLockCode): string => LOCK[code];
