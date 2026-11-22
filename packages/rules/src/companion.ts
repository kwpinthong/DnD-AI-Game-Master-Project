import type { Period } from './phase/types.ts';
import type { NpcGrade } from './resolution/types.ts';

/**
 * NPC companions and evolution (GEN-054). The NPC tab of the Asset sheet wins over the GDD: the server
 * turns each NPC's Evolution / Unlock Condition into an `EvolutionRule` and these pure functions judge it.
 * The server stores the state; the AI GM loop (GEN-057) calls the server functions.
 */

/** A player keeps at most 3 NPCs: 1 main (highest affinity) + 2 secondary (GDD §5). */
export const COMPANION_LIMIT = 3;

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
/** Most an affinity may move in one action (Rules Spec §7). */
export const AFFINITY_PER_ACTION = 10;

export type NpcRuleErrorCode = 'not_integer' | 'out_of_range' | 'grade_not_spawnable';
export interface NpcRuleError {
  readonly code: NpcRuleErrorCode;
  readonly message: string;
}

export type AffinityChange =
  | { readonly ok: true; readonly before: number; readonly delta: number; readonly after: number }
  | { readonly ok: false; readonly error: NpcRuleError };

/** Applies one action's affinity delta: rejected outside -10..+10 (never trimmed), result clamped to -100..100. */
export function applyAffinityDelta(current: number, delta: number): AffinityChange {
  if (!Number.isInteger(delta)) return { ok: false, error: { code: 'not_integer', message: 'affinity delta must be an integer' } };
  if (Math.abs(delta) > AFFINITY_PER_ACTION) {
    return {
      ok: false,
      error: { code: 'out_of_range', message: `affinity delta must be within -${AFFINITY_PER_ACTION}..+${AFFINITY_PER_ACTION} per action` },
    };
  }
  const after = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, current + delta));
  return { ok: true, before: current, delta, after };
}

export interface CompanionSlot {
  readonly npcId: string;
  readonly affinity: number;
  /** Save order: lower = saved earlier. */
  readonly seq: number;
}

/** Main companion = highest affinity, a tie goes to the one saved first; the rest are secondary. */
export function rankCompanions<T extends CompanionSlot>(slots: readonly T[]): { main: T | null; secondary: T[] } {
  const [main = null, ...secondary] = [...slots].sort((a, b) => b.affinity - a.affinity || a.seq - b.seq);
  return { main, secondary };
}

/** Q-103: only grade B hides its real name until revealed; F / A / S (and an evolved SS) show it from the start. */
export function npcNameShown(grade: NpcGrade, nameRevealed: boolean): boolean {
  return grade !== 'B' || nameRevealed;
}

const SPAWNABLE: readonly string[] = ['F', 'B', 'A', 'S'];

/** null when the AI may bring a new NPC of this rank into play. SS never spawns (only F evolves to it). */
export function checkNpcSpawn(rank: string): NpcRuleError | null {
  if (SPAWNABLE.includes(rank)) return null;
  return { code: 'grade_not_spawnable', message: `a new NPC cannot be grade ${rank}; SS only evolves from F` };
}

// --- Evolution ---

export type NpcAlignment = 'Good' | 'Evil' | 'Neutral';

export type EvolutionCondition =
  | { readonly type: 'affinity'; readonly min: number }
  | { readonly type: 'karma'; readonly min?: number; readonly max?: number }
  /** A flag the AI GM sets. `day` / `minDay`: the server only accepts it on that day / from that day. */
  | { readonly type: 'flag'; readonly flag: string; readonly count?: number; readonly day?: number; readonly minDay?: number }
  /** `periodsPerDay` distinct periods with the NPC on each of `days` days in a row, all from `fromDay`, karma inside the band all those days. */
  | {
      readonly type: 'activityStreak';
      readonly fromDay: number;
      readonly days: number;
      readonly periodsPerDay: number;
      readonly karmaMin: number;
      readonly karmaMax: number;
    }
  /** Karma inside min..max on every day seen up to `untilDay`, which must have been reached and seen. */
  | { readonly type: 'karmaBandThrough'; readonly min: number; readonly max: number; readonly untilDay: number };

export interface EvolutionPath {
  /** Which Rewards / true-name segment this path opens ("สาย Good"); null = the NPC's only one. */
  readonly alignment: NpcAlignment | null;
  readonly all: readonly EvolutionCondition[];
}

export interface EvolutionRule {
  /** F → SS, A → S, S → S (awakened). */
  readonly to: 'S' | 'SS';
  /** Any one path is enough. */
  readonly paths: readonly EvolutionPath[];
}

/** What the server knows about one player and one NPC when it checks a rule. */
export interface NpcProgress {
  readonly affinity: number;
  readonly karma: number;
  /** The current game day. */
  readonly day: number;
  readonly flags: Readonly<Record<string, { readonly count: number }>>;
  /** Turns the player spent with the NPC (recorded by the AI GM loop). */
  readonly activities: readonly { readonly day: number; readonly period: Period }[];
  /** Lowest / highest karma seen on each game day. */
  readonly karmaDays: Readonly<Record<number, { readonly min: number; readonly max: number }>>;
}

/** The first path of `rule` whose every condition holds now, or null. */
export function evolutionPath(rule: EvolutionRule, progress: NpcProgress): EvolutionPath | null {
  return rule.paths.find((path) => path.all.every((c) => conditionMet(c, progress))) ?? null;
}

function conditionMet(c: EvolutionCondition, p: NpcProgress): boolean {
  switch (c.type) {
    case 'affinity':
      return p.affinity >= c.min;
    case 'karma':
      return (c.min === undefined || p.karma >= c.min) && (c.max === undefined || p.karma <= c.max);
    case 'flag':
      return (p.flags[c.flag]?.count ?? 0) >= (c.count ?? 1);
    case 'activityStreak':
      return activityStreakMet(c, p);
    case 'karmaBandThrough': {
      if (p.day < c.untilDay || !p.karmaDays[c.untilDay]) return false;
      return Object.entries(p.karmaDays).every(([day, k]) => Number(day) > c.untilDay || (k.min >= c.min && k.max <= c.max));
    }
  }
}

function activityStreakMet(c: Extract<EvolutionCondition, { type: 'activityStreak' }>, p: NpcProgress): boolean {
  const periods = new Map<number, Set<Period>>();
  for (const a of p.activities) periods.set(a.day, (periods.get(a.day) ?? new Set()).add(a.period));
  const dayCounts = (day: number) => {
    const k = p.karmaDays[day];
    return (periods.get(day)?.size ?? 0) >= c.periodsPerDay && k !== undefined && k.min >= c.karmaMin && k.max <= c.karmaMax;
  };
  let run = 0;
  for (let day = c.fromDay; day <= p.day; day++) {
    run = dayCounts(day) ? run + 1 : 0;
    if (run >= c.days) return true;
  }
  return false;
}
