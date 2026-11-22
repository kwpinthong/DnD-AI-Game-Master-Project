import type { NpcGrade } from './resolution/types.ts';

/** What other people see of someone's HP (Rules Spec §2.2 bands; HP 0 = unconscious, Q-057). */
export type InjuryText = 'ปกติ' | 'บาดเจ็บ' | 'สาหัส' | 'หมดสติ';

/** HP 50-100 ปกติ / 25-49 บาดเจ็บ / 1-24 สาหัส / 0 หมดสติ (same bands as the conditions in tables.ts). */
export function injuryText(hp: number): InjuryText {
  if (hp <= 0) return 'หมดสติ';
  if (hp <= 24) return 'สาหัส';
  if (hp <= 49) return 'บาดเจ็บ';
  return 'ปกติ';
}

/** Affinity that reveals a grade B NPC's real name to that player (Rules Spec §8.1). */
export const NPC_NAME_REVEAL_AFFINITY = 9;

/**
 * Whether this affinity reveals the NPC's real name. Only grade B has an affinity rule (Rules Spec §8.1);
 * the reveal is permanent, so callers keep `nameRevealed` once it is true.
 */
export function revealsNpcName(rank: NpcGrade, affinity: number): boolean {
  return rank === 'B' && affinity >= NPC_NAME_REVEAL_AFFINITY;
}
