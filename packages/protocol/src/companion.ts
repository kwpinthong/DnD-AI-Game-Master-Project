import { z } from 'zod';
import { BondView } from './view-models.ts';

/**
 * NPC companions (GEN-054, GDD §5): a player keeps at most 3 NPCs, 1 main (highest affinity) and 2
 * secondary. Players never get affinity numbers, karma or the NPC grade; `ref` is the opaque handle
 * of an NPC in this game (the same one GET /api/game/surroundings gives).
 */

export const CompanionView = z.strictObject({
  ref: z.string(),
  /** The alias until `nameRevealed` for this player, then the real name. */
  name: z.string(),
  nameRevealed: z.boolean(),
  role: z.enum(['main', 'secondary']),
  /** F4: the bond as a word + a 6-step bar, never the affinity number (pending, see docs/contract.md). */
  bond: BondView.optional(),
});
export type CompanionView = z.infer<typeof CompanionView>;

/** 200 from GET /api/game/companions (also the body of a successful save / release): main first. */
export const CompanionsResponse = z.strictObject({ companions: z.array(CompanionView) });
export type CompanionsResponse = z.infer<typeof CompanionsResponse>;

/** Body of POST /api/game/companions: save the NPC at your place with this `ref`. */
export const SaveCompanionRequest = z.object({ ref: z.string().min(1, 'เลือก NPC ที่จะบันทึก') });
export type SaveCompanionRequest = z.infer<typeof SaveCompanionRequest>;
