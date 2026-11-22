import type { NpcAlignment } from './companion.ts';
import { PERIODS, type Period } from './phase/types.ts';
import type { Tier } from './resolution/types.ts';

/**
 * Skills and items of the Asset sheet (GEN-055): Rank B / A / S / SS instead of Common / Rare / Legendary,
 * and the Condition column as unlock rules the server can check. The sheet text is free Thai, so the server
 * writes each condition as a `SkillUnlockRule` (apps/server/src/skills/unlock-rules.ts) and these pure
 * functions judge it against the progress the server counts in the background. Players never see a
 * condition or its progress (only an INVESTIGATE at the library reveals one condition).
 */

export const SKILL_RANKS = ['B', 'A', 'S', 'SS'] as const;
export type SkillRank = (typeof SKILL_RANKS)[number];

/**
 * The judged-modifier tier of a Rank (Q-114 / Q-122: B +2, A +3, S / SS +5), so the resolution engine's
 * `TIER_CAP` caps a skill / item of the sheet by its Rank.
 */
export const RANK_TIER: Readonly<Record<SkillRank, Tier>> = { B: 'Common', A: 'Rare', S: 'Legendary', SS: 'Legendary' };

/**
 * What the server counts per period (`activities`): `verb:<TAG>` = an action with that verb tag (PRAY),
 * `act` = any action, `good` / `evil` = an action whose karma went up / down, `good_public` / `evil_secret`
 * the same as a Public / Secret action, `karma_steady` = a period that ended with the karma it started with.
 */
export type SkillActivity = string;

export type SkillCondition =
  /** Karma now within min..max. */
  | { readonly type: 'karma'; readonly min?: number; readonly max?: number }
  /** Owns this skill (Ability name). */
  | { readonly type: 'skill'; readonly name: string }
  /** Owns at least one skill of this Rank and alignment. */
  | { readonly type: 'skillOf'; readonly rank: SkillRank; readonly alignment: NpcAlignment }
  /** Holds this item (Item English name). */
  | { readonly type: 'holding'; readonly item: string }
  /** An event only the AI GM can judge, `count` times (default 1). */
  | { readonly type: 'flag'; readonly flag: string; readonly count?: number }
  /** `activity` in at least `count` distinct periods (only `period` when given). */
  | { readonly type: 'periods'; readonly activity: SkillActivity; readonly count: number; readonly period?: Period }
  /** `activity` in `periods` periods in a row (across the night into the next day). */
  | { readonly type: 'periodRun'; readonly activity: SkillActivity; readonly periods: number }
  /**
   * `activity` in `periodsPerDay` distinct periods on each of `days` days in a row (a missed day starts the
   * count again), from `fromDay`; with karmaMin / karmaMax, the day's karma stays inside the band all day.
   */
  | {
      readonly type: 'streak';
      readonly activity: SkillActivity;
      readonly days: number;
      readonly periodsPerDay: number;
      readonly fromDay?: number;
      readonly karmaMin?: number;
      readonly karmaMax?: number;
    }
  /** Karma inside min..max all day on `days` finished days in a row. */
  | { readonly type: 'karmaDays'; readonly min: number; readonly max: number; readonly days: number };

export interface SkillUnlockPath {
  readonly all: readonly SkillCondition[];
  /** Where the path comes from: the skill's own Condition, or an item's Skill Synergy ("item:<name>"). */
  readonly source: string;
}

export interface SkillUnlockRule {
  /** Any one path is enough. */
  readonly paths: readonly SkillUnlockPath[];
}

export interface OwnedSkillFact {
  readonly name: string;
  readonly rank: SkillRank;
  readonly alignment: NpcAlignment;
}

/** What the server knows about one player when it checks a rule. */
export interface SkillProgress {
  readonly day: number;
  readonly karma: number;
  readonly skills: readonly OwnedSkillFact[];
  /** Item English names the player holds now. */
  readonly holding: readonly string[];
  readonly flags: Readonly<Record<string, number>>;
  readonly activities: readonly { readonly activity: SkillActivity; readonly day: number; readonly period: Period }[];
  /** Lowest / highest karma seen on each game day. */
  readonly karmaDays: Readonly<Record<number, { readonly min: number; readonly max: number }>>;
}

/** The first path of `rule` whose every condition holds now, or null. */
export function unlockPath(rule: SkillUnlockRule, progress: SkillProgress): SkillUnlockPath | null {
  return rule.paths.find((path) => path.all.every((c) => conditionMet(c, progress))) ?? null;
}

/** Periods since day 1 EOSORIA (0-based): NOCTHERION of day d is followed by EOSORIA of day d + 1. */
const periodIndex = (day: number, period: Period) => (day - 1) * PERIODS.length + PERIODS.indexOf(period);

function periodsOf(p: SkillProgress, activity: SkillActivity): Map<number, Set<Period>> {
  const byDay = new Map<number, Set<Period>>();
  for (const a of p.activities) if (a.activity === activity) byDay.set(a.day, (byDay.get(a.day) ?? new Set()).add(a.period));
  return byDay;
}

const inBand = (k: { readonly min: number; readonly max: number } | undefined, min: number, max: number) => k !== undefined && k.min >= min && k.max <= max;

function conditionMet(c: SkillCondition, p: SkillProgress): boolean {
  switch (c.type) {
    case 'karma':
      return (c.min === undefined || p.karma >= c.min) && (c.max === undefined || p.karma <= c.max);
    case 'skill':
      return p.skills.some((s) => s.name === c.name);
    case 'skillOf':
      return p.skills.some((s) => s.rank === c.rank && s.alignment === c.alignment);
    case 'holding':
      return p.holding.includes(c.item);
    case 'flag':
      return (p.flags[c.flag] ?? 0) >= (c.count ?? 1);
    case 'periods': {
      let n = 0;
      for (const periods of periodsOf(p, c.activity).values()) n += c.period === undefined ? periods.size : periods.has(c.period) ? 1 : 0;
      return n >= c.count;
    }
    case 'periodRun': {
      const indices = [...periodsOf(p, c.activity)].flatMap(([day, periods]) => [...periods].map((period) => periodIndex(day, period)));
      const set = new Set(indices);
      return indices.some((start) => Array.from({ length: c.periods }, (_, i) => start + i).every((i) => set.has(i)));
    }
    case 'streak': {
      const byDay = periodsOf(p, c.activity);
      const banded = c.karmaMin !== undefined || c.karmaMax !== undefined;
      const dayCounts = (day: number) =>
        (byDay.get(day)?.size ?? 0) >= c.periodsPerDay && (!banded || inBand(p.karmaDays[day], c.karmaMin ?? -Infinity, c.karmaMax ?? Infinity));
      let run = 0;
      for (let day = c.fromDay ?? 1; day <= p.day; day++) {
        run = dayCounts(day) ? run + 1 : 0;
        if (run >= c.days) return true;
      }
      return false;
    }
    case 'karmaDays': {
      let run = 0;
      for (let day = 1; day < p.day; day++) {
        run = inBand(p.karmaDays[day], c.min, c.max) ? run + 1 : 0;
        if (run >= c.days) return true;
      }
      return false;
    }
  }
}
