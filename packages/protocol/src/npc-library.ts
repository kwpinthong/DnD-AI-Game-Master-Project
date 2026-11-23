import { z } from 'zod';
import { Phase } from './scenario.ts';
import { AdminCorrection, ReviewScene } from './vote-review.ts';
import { StyleGoodCandidate } from './style-review.ts';

/**
 * GEN-151: the server owner's NPC example library (admin code only). An example is a message players gave a 👍
 * (GEN-107) or the edited text of a "แก้เป็น" pair sent to the library (GEN-168, Q-337), given to one NPC and
 * tagged with a scene kind. Stored with tokens only (`{{n:id}}` for NPCs, `{{p:player}}` for any player); the
 * dialogue prompt carries ≤ 3 per NPC.
 */

export const NpcExample = z.strictObject({
  id: z.number().int().min(1),
  npcId: z.string(),
  scene: ReviewScene,
  /** Tokens only, never a real name. */
  text: z.string(),
  source: z.enum(['vote', 'correction']),
  gameId: z.string(),
  seq: z.number().int().min(1),
  createdAt: z.string(),
});
export type NpcExample = z.infer<typeof NpcExample>;

export const NpcChoice = z.strictObject({ id: z.string(), name: z.string() });
export type NpcChoice = z.infer<typeof NpcChoice>;

export const AdminUpvoteEntry = z.strictObject({
  gameId: z.string(),
  gameName: z.string(),
  seq: z.number().int().min(1),
  scene: ReviewScene,
  npc: NpcChoice.nullable(),
  at: z.strictObject({ day: z.number().int(), phase: Phase, turn: z.number().int().min(1).max(2) }),
  /** The text as stored (real names: the owner's page only). */
  text: z.string(),
  up: z.number().int().min(1),
  inLibrary: z.boolean(),
});
export type AdminUpvoteEntry = z.infer<typeof AdminUpvoteEntry>;

/** 200 from every /api/admin/npc-library route: the whole library and what may go into it. */
export const NpcLibraryResponse = z.strictObject({
  /** Every NPC with at least one example, examples oldest first. */
  npcs: z.array(z.strictObject({ npcId: z.string(), npcName: z.string(), examples: z.array(NpcExample) })),
  /** AI messages with a 👍, newest first. */
  upvoted: z.array(AdminUpvoteEntry),
  /** Pairs marked for the library that are not in it (an NPC must be picked: the message was not an NPC's). */
  candidates: z.array(AdminCorrection),
  /** The NPCs of the games' scenarios, to give an example to. */
  npcChoices: z.array(NpcChoice),
  /** GEN-084 (Q-322): NPC lines of ended games most players liked (GEN-081 good_example), not in the library yet; tokens + "ผู้เล่น". */
  goodLines: z.array(StyleGoodCandidate),
});
export type NpcLibraryResponse = z.infer<typeof NpcLibraryResponse>;

/** Body of POST /api/admin/npc-library. */
export const NpcExampleAddRequest = z.discriminatedUnion('from', [
  z.object({ from: z.literal('vote'), gameId: z.string().min(1), seq: z.number().int().min(1), npcId: z.string().min(1), scene: ReviewScene }),
  /** `npcId`: needed when the pair's message is not an NPC's line. */
  z.object({ from: z.literal('correction'), correctionId: z.number().int().min(1), npcId: z.string().min(1).optional() }),
]);
export type NpcExampleAddRequest = z.input<typeof NpcExampleAddRequest>;
