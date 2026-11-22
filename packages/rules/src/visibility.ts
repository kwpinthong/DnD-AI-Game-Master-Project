import type { NpcGrade } from './resolution/types.ts';

/** What other people see of someone's HP (Rules Spec §2.2 bands; HP 0 = unconscious, Q-057). */
export type InjuryText = 'ปกติ' | 'บาดเจ็บ' | 'สาหัส' | 'หมดสติ';

/**
 * Shares of the character's own Max HP (Q-197: Max HP is 30..45 by start scenario / TRAIN, not 100): at least
 * half ปกติ / at least a quarter บาดเจ็บ / above 0 สาหัส / 0 หมดสติ. At Max 100 these are the old
 * 50-100 / 25-49 / 1-24 bands. Integer maths, so no rounding at the edges.
 */
export function injuryText(hp: number, maxHp: number): InjuryText {
  if (hp <= 0) return 'หมดสติ';
  const max = Math.max(1, maxHp);
  if (hp * 2 >= max) return 'ปกติ';
  if (hp * 4 >= max) return 'บาดเจ็บ';
  return 'สาหัส';
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

/** Relationship between two players runs -100..+100 (GEN-067); only the AI GM / engine changes it. */
export const RELATIONSHIP_MIN = -100;
export const RELATIONSHIP_MAX = 100;

/** Relationship an alliance must be above to show the real name and open Whisper (sheet Fog of War: "> +9"). */
export const PLAYER_NAME_REVEAL_RELATIONSHIP = 9;

/**
 * Title Mask (GEN-067, sheet Fog of War): another player sees only the Title until the two are allies with
 * relationship > +9; then each sees the other's real name and may Whisper. This replaces GEN-050's
 * "introduced" rule. It is not permanent: a broken alliance or a drop hides the name again. A name the
 * viewer discovered (สืบรู้, Q-134) also shows, for good; the server keeps that per viewer (`known_name`).
 */
export function revealsPlayerName(bond: { readonly alliance: boolean; readonly relationship: number } | undefined): boolean {
  return bond !== undefined && bond.alliance && bond.relationship > PLAYER_NAME_REVEAL_RELATIONSHIP;
}
