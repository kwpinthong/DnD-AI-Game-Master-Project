import { PHASES, weatherText, type BondView, type HitChange, type Phase, type RollOutcome, type RollView, type RoomEntry, type RoomState, type RoomViewLockCode, type TurnChange } from '@isekai/protocol';
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
  changes: 'private',
  // GEN-110: public lines belong to the place, `npc.private` ones to your column; the chat UI (GEN-122) decides per entry.
  npc: 'place',
  // GEN-129: another player's public action, at the place.
  player: 'place',
  // GEN-145: the new period's announcement, for the whole room.
  time: 'place',
  // ISK-014: the morning news, the same for the whole game.
  news: 'place',
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

// --- GEN-088: the Play screen ---

export interface TurnAt {
  day: number;
  phase: Phase;
  turn: number;
}

/** The turn after this one: turn 1 → 2, then the next period, NOCTHERION turn 2 → the next day's EOSORIA. */
export function nextTurn(at: TurnAt): TurnAt {
  if (at.turn === 1) return { ...at, turn: 2 };
  const i = PHASES.indexOf(at.phase);
  return i === PHASES.length - 1 ? { day: at.day + 1, phase: PHASES[0], turn: 1 } : { day: at.day, phase: PHASES[i + 1]!, turn: 1 };
}

/** "SOLARION เทิร์น 2"; with the day in front when it is not `today`. */
export const turnName = (at: TurnAt, today = at.day): string =>
  at.day === today ? playText.turnName(at.phase, at.turn) : playText.dayTurnName(at.day, at.phase, at.turn);

const LAST_DAY = 12;

interface Gauge {
  current: number;
  max: number;
}

/** HP as a word by its share of Max HP (Q-197), the same steps as the server's `injuryText`; 0 = สลบ (GEN-070). */
export function injuryWord(hp: Gauge): string {
  if (hp.current <= 0) return playText.self.injury.down;
  const max = Math.max(1, hp.max);
  if (hp.current * 2 >= max) return playText.self.injury.fine;
  return hp.current * 4 >= max ? playText.self.injury.hurt : playText.self.injury.critical;
}

/** Stamina as a word, by its share of the maximum. */
export function staminaWord(stamina: Gauge): string {
  if (stamina.current <= 0) return playText.self.energy.spent;
  const max = Math.max(1, stamina.max);
  if (stamina.current * 2 >= max) return playText.self.energy.fine;
  return stamina.current * 4 >= max ? playText.self.energy.tired : playText.self.energy.low;
}

/**
 * The Secret quota in words: `status` for the status column, `blocked` = why the ลับ switch is closed and when
 * it opens again (the quota resets with the new day), null while it can be used.
 */
export function secretQuota(room: Pick<RoomState, 'day' | 'phase'> & { you: Pick<RoomState['you'], 'secretUsed'> }): { status: string; blocked: string | null } {
  const night = room.phase === 'NOCTHERION';
  if (!room.you.secretUsed) return { status: night ? playText.secret.nightFree : playText.secret.left, blocked: null };
  const resetDay = room.day < LAST_DAY ? room.day + 1 : null;
  return { status: playText.secret.used(resetDay), blocked: night ? playText.secret.usedTonight(resetDay) : playText.secret.usedToday(resetDay) };
}

/** Under the lock message: what the state means and when the action box opens again. Exhaustive over the lock codes. */
export function lockDetail(room: Pick<RoomState, 'day' | 'phase' | 'turn'>, code: RoomViewLockCode): string | null {
  const back = playText.action.backAt(turnName(nextTurn(room), room.day));
  const detail: Record<RoomViewLockCode, string | null> = {
    exhausted: `${back} ${playText.lockDetail.exhausted}`,
    traveling: back,
    unconscious: playText.lockDetail.unconscious,
    recovering: playText.lockDetail.recovering,
    resolving: playText.lockDetail.resolving,
    game_ended: playText.lockDetail.game_ended,
    astral_spirit: null,
    not_a_player: null,
  };
  return detail[code];
}

/** The omen box of an Astral Spirit (Q-193): why it is closed and when it opens again; null = it can be sent now. */
export function omenBlocked(room: Pick<RoomState, 'day' | 'phase'>, canSend: boolean): string | null {
  if (canSend) return null;
  if (room.phase !== 'NOCTHERION') return playText.omen.tonight;
  return playText.omen.sentTonight(room.day < LAST_DAY ? room.day + 1 : null);
}

/** One changed value on the hit card: "เหรียญ -12", "ของที่หาย: Prism of Truth" (own values only). */
export function hitChangeText(change: HitChange): string {
  const label = playText.hit[change.stat];
  if ('delta' in change) return `${label} ${change.delta > 0 ? '+' : ''}${change.delta}`;
  return `${label}: ${change.name}`;
}

/** GEN-114: one line of the turn log: "แรง -3 · เดินทางข้ามโซน". Karma is only the word the status bar shows. */
export function turnChangeText(change: TurnChange): string {
  const label = playText.changes.stat[change.stat];
  const what =
    'delta' in change ? `${label} ${change.delta > 0 ? '+' : ''}${change.delta}` : change.stat === 'conduct'
        ? `${label} ${change.from} → ${change.to}`
        : change.stat === 'bond'
          ? `${label} ${change.name} ${change.from} → ${change.to}`
          : `${label}: ${change.name}`;
  return `${what} · ${change.reason}`;
}

export interface TurnGroup {
  key: string;
  heading: string;
  entries: RoomEntry[];
}

/** Entries in the order they came, cut into runs of the same turn, each under "วันที่ 3 · SOLARION เทิร์น 1". */
export function turnGroups(entries: readonly RoomEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const entry of entries) {
    const heading = playText.dayTurnName(entry.day, entry.phase, entry.turn);
    const last = groups.at(-1);
    if (last && last.heading === heading) last.entries.push(entry);
    else groups.push({ key: `${heading}#${entry.seq}`, heading, entries: [entry] });
  }
  return groups;
}

/** How a sent action is described back: "ลับ · พัก / นอน". */
export function sentHow(action: NonNullable<RoomState['you']['action']>, visibilityLabel: Record<'public' | 'secret', string>): string {
  return [visibilityLabel[action.visibility], action.rest ? playText.action.rest : null, action.train ? 'TRAIN' : null].filter((s): s is string => s !== null).join(' · ');
}
