import { z } from 'zod';
import { CharacterView } from './character.ts';

/**
 * Information asymmetry (GEN-050, GDD §1-§2): what each viewer may see. Every schema here is strict so
 * a new field is a deliberate change. Players never get Karma, the Reputation number or affinity numbers.
 */

/** HP as words (Rules Spec §2.2): 50-100 ปกติ / 25-49 บาดเจ็บ / 1-24 สาหัส / 0 หมดสติ. */
export const InjuryText = z.enum(['ปกติ', 'บาดเจ็บ', 'สาหัส', 'หมดสติ']);
export type InjuryText = z.infer<typeof InjuryText>;

/**
 * Another character at the viewer's place. `ref` is an opaque handle (not the member id, so it cannot be
 * matched to the lobby's player names). `name` is null until this viewer was introduced or found it out.
 * No HP, Stamina or location: the place is the viewer's own.
 */
export const OtherCharacterView = z.strictObject({
  ref: z.string(),
  appearance: z.string(),
  injury: InjuryText,
  socialTitle: z.string(),
  name: z.string().nullable(),
});
export type OtherCharacterView = z.infer<typeof OtherCharacterView>;

/** An NPC at the viewer's place: its alias until `nameRevealed` for this viewer, then its real name. */
export const NpcView = z.strictObject({
  name: z.string(),
  nameRevealed: z.boolean(),
});
export type NpcView = z.infer<typeof NpcView>;

export const PlaceView = z.strictObject({ id: z.string(), name: z.string() });
export type PlaceView = z.infer<typeof PlaceView>;

/** A character as the Human GM sees it: every field, Karma, the Reputation number and the place included. */
export const GmCharacterView = z.strictObject({
  memberId: z.string(),
  ref: z.string().nullable(),
  playerName: z.string(),
  name: z.string(),
  appearance: z.string(),
  personality: z.string(),
  hp: z.strictObject({ current: z.number().int(), max: z.number().int() }),
  stamina: z.strictObject({ current: z.number().int(), max: z.number().int() }),
  injury: InjuryText,
  socialTitle: z.string(),
  reputationScore: z.number().int(),
  karma: z.number().int(),
  /** The adjective the owner sees for that Karma (GEN-067). */
  conduct: z.string(),
  locationId: z.string().nullable(),
  /** Member ids of the characters whose real name this character sees (allies with relationship > +9, GEN-067). */
  knowsNamesOf: z.array(z.string()),
  npcBonds: z.array(z.strictObject({ npcId: z.string(), affinity: z.number().int(), nameRevealed: z.boolean() })),
  /** Alliance and relationship with each other player that has a bond row (GEN-067). */
  playerBonds: z.array(z.strictObject({ memberId: z.string(), alliance: z.boolean(), relationship: z.number().int() })),
});
export type GmCharacterView = z.infer<typeof GmCharacterView>;

/** A Hidden Evidence Tag as the Human GM sees it (GEN-067): every one in the game, with who left it. */
export const GmEvidenceView = z.strictObject({
  id: z.number().int(),
  locationId: z.string(),
  day: z.number().int(),
  actorMemberId: z.string(),
});
export type GmEvidenceView = z.infer<typeof GmEvidenceView>;

/**
 * 200 from GET /api/game/surroundings. A player gets their own character, their place and who / which
 * NPCs are there; `place` is null (and the lists empty) before the game places them.
 */
export const SurroundingsResponse = z.discriminatedUnion('view', [
  z.strictObject({
    view: z.literal('player'),
    you: CharacterView.nullable(),
    place: PlaceView.nullable(),
    people: z.array(OtherCharacterView),
    npcs: z.array(NpcView),
  }),
  z.strictObject({ view: z.literal('gm'), characters: z.array(GmCharacterView), evidence: z.array(GmEvidenceView) }),
]);
export type SurroundingsResponse = z.infer<typeof SurroundingsResponse>;
