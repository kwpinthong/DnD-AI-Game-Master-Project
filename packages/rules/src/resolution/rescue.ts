import { rollDice } from '../dice.ts';
import type { Rng } from '../rng.ts';
import { affinityMod } from './tables.ts';

/** Location safety from the scenario (spec §12.2, Q-055). */
export type Safety = 'safe' | 'normal' | 'danger' | 'restricted';
export type RescueOutcome = 'rescued' | 'alone' | 'exploited';

/** `restricted` (the sheet's RESTRICTED, Q-161) has no number of its own yet: same as normal. */
export const SAFETY_MOD: Readonly<Record<Safety, number>> = { safe: 4, normal: 0, danger: -4, restricted: 0 };

/** Another player's general action against the unconscious character at this DC rescues at once (Q-056). */
export const RESCUE_AID_DC = 8;

/** HP and minimum Stamina on waking (spec §12.2). */
export const WAKE: Readonly<Record<RescueOutcome, { readonly hp: number; readonly stamina: number }>> = {
  rescued: { hp: 30, stamina: 20 },
  alone: { hp: 10, stamina: 15 },
  exploited: { hp: 10, stamina: 10 },
};

/** rescue = d20 + safety + 2 x trunc(primary companion affinity / 20). */
export function rescueScore(d20: number, safety: Safety, primaryAffinity: number): number {
  return d20 + SAFETY_MOD[safety] + 2 * affinityMod(primaryAffinity);
}

/** Bands: >= 15 rescued / 8..14 alone / <= 7 exploited. */
export function rescueOutcome(score: number): RescueOutcome {
  if (score >= 15) return 'rescued';
  if (score >= 8) return 'alone';
  return 'exploited';
}

/**
 * The wake-up rescue roll when no player aided. HP 0 is never death (Q-057).
 * When to roll it (start of the next Morning, after the lost phases) is phase logic (GEN-052).
 */
export function rollRescue(
  input: { readonly safety: Safety; readonly primaryAffinity: number },
  rng: Rng,
): { readonly d20: number; readonly score: number; readonly outcome: RescueOutcome } {
  const d20 = rollDice('1d20', rng).faces[0]!;
  const score = rescueScore(d20, input.safety, input.primaryAffinity);
  return { d20, score, outcome: rescueOutcome(score) };
}

/** HP and Stamina after waking: Stamina never drops below what the character had. */
export function wakeAfter(outcome: RescueOutcome, stamina: number): { readonly hp: number; readonly stamina: number } {
  const wake = WAKE[outcome];
  return { hp: wake.hp, stamina: Math.max(stamina, wake.stamina) };
}
