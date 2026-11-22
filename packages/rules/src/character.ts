import { RULES, repTier } from './resolution/tables.ts';

/** A new character's stats (GDD §2, Rules Spec). Only the engine changes them afterwards. */
export const STARTING_STATS = {
  hp: RULES.hpMax,
  hpMax: RULES.hpMax,
  stamina: RULES.staminaMax,
  staminaMax: RULES.staminaMax,
  reputation: 0,
  karma: 0,
} as const;

/** What players see instead of the Reputation number (Rules Spec Social Title). */
export const socialTitle = (reputation: number): string => repTier(reputation).title;
