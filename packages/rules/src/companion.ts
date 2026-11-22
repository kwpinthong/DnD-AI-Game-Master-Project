import type { Degree, NpcGrade, Tier } from './resolution/types.ts';

/**
 * NPC companions, grades and evolution (GEN-054, GDD §5, Rules Spec §7-§8). Pure rules: the server
 * stores the state and the AI GM loop (GEN-057) calls these through the server functions.
 */

/** A player keeps at most 3 NPCs: 1 main (highest affinity) + 2 secondary (GDD §5). */
export const COMPANION_LIMIT = 3;

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
/** Most an affinity may move in one action (Rules Spec §7). */
export const AFFINITY_PER_ACTION = 10;

/** F → SS: affinity and |karma| thresholds (Rules Spec §8.2, tunable). */
export const EVOLUTION = { fToSsAffinity: 70, fToSsKarma: 40 } as const;
/** A crisis-aid action needs this DC or higher and a success / crit (Rules Spec §8.3). */
export const CRISIS_AID_MIN_DC = 17;

/** The two SS identities a grade F NPC can become (GDD §5): good karma / evil karma. */
export type NpcForm = 'angel' | 'blood-moon';
export const NPC_FORM_LABEL: Readonly<Record<NpcForm, string>> = { angel: 'ทูตสวรรค์', 'blood-moon': 'เทพมารจันทราโลหิต' };

/** Reward tiers each grade may hand out (GDD §5 / Rules Spec §8.1). F gives nothing until it is SS. */
export const REWARD_TIERS: Readonly<Record<NpcGrade, readonly Tier[]>> = {
  F: [],
  B: ['Common', 'Rare'],
  A: ['Rare'],
  S: ['Rare'],
  SS: ['Legendary'],
};

/**
 * Affinity at which an NPC tells this player its real name (Q-084). B +9 is the GDD rule; the others
 * follow "the higher the grade, the more guarded": F +5 (a grateful burden), A +20 (where affinity
 * starts to count as a roll modifier, Rules Spec §2.2), S +40, SS always (it only evolves from F at +70).
 */
export const NAME_REVEAL_AFFINITY: Readonly<Record<NpcGrade, number>> = { F: 5, B: 9, A: 20, S: 40, SS: AFFINITY_MIN };

export type NpcRuleErrorCode = 'not_integer' | 'out_of_range' | 'tier_not_allowed' | 'grade_not_spawnable';
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
    return { ok: false, error: { code: 'out_of_range', message: `affinity delta must be within -${AFFINITY_PER_ACTION}..+${AFFINITY_PER_ACTION} per action` } };
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

export interface EvolutionInput {
  readonly grade: NpcGrade;
  readonly affinity: number;
  /** The player's karma (hidden). */
  readonly karma: number;
  /** The player helped this NPC through a crisis (flag set by the AI GM loop). */
  readonly crisisAided: boolean;
  /** F → SS is checked at the end of Night only (Rules Spec §8.2); A → S at the end of any phase. */
  readonly nightEnd: boolean;
}

export type Evolution = { readonly grade: 'SS'; readonly form: NpcForm } | { readonly grade: 'S'; readonly form: null };

/** The grade this NPC evolves to now, or null. Each NPC evolves once: SS and S never evolve again. */
export function evolveNpc(input: EvolutionInput): Evolution | null {
  if (input.grade === 'A') return input.crisisAided ? { grade: 'S', form: null } : null;
  if (input.grade !== 'F' || !input.nightEnd || input.affinity < EVOLUTION.fToSsAffinity) return null;
  if (input.karma >= EVOLUTION.fToSsKarma) return { grade: 'SS', form: 'angel' };
  if (input.karma <= -EVOLUTION.fToSsKarma) return { grade: 'SS', form: 'blood-moon' };
  return null;
}

/** Whether a resolved action counts as helping an NPC through a crisis (Rules Spec §8.3). */
export function isCrisisAid(dc: number | null, degree: Degree): boolean {
  return dc !== null && dc >= CRISIS_AID_MIN_DC && (degree === 'success' || degree === 'crit');
}

/** null when an NPC of `grade` may give a reward of `tier`. */
export function checkNpcReward(grade: NpcGrade, tier: Tier): NpcRuleError | null {
  if (REWARD_TIERS[grade].includes(tier)) return null;
  return { code: 'tier_not_allowed', message: `a grade ${grade} NPC cannot give a ${tier} reward` };
}

/** null when the AI may bring a new NPC of this rank into play. SS never spawns (only F evolves to it). */
export function checkNpcSpawn(rank: string): NpcRuleError | null {
  if (SPAWNABLE.includes(rank)) return null;
  return { code: 'grade_not_spawnable', message: `a new NPC cannot be grade ${rank}; SS only evolves from F` };
}

const SPAWNABLE: readonly string[] = ['F', 'B', 'A', 'S'];
