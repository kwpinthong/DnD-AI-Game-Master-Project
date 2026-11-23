import { z } from 'zod';

/**
 * GEN-169: the server's style checker (forbidden phrases of the Voice data set + an NPC's pronouns), for the server
 * owner only. Counts per NPC per reason, never the text; an NPC shows by its id and public alias (no real name).
 */

/** The checker's settings. `rewrite`: a block rule hit ("ทำการ", emoji / markdown) asks the AI to rewrite once. */
export const StyleSettings = z.strictObject({ rewrite: z.boolean() });
export type StyleSettings = z.infer<typeof StyleSettings>;

/** 200 from GET / PUT /api/admin/style-settings. */
export const StyleSettingsResponse = z.strictObject({ settings: StyleSettings });
export type StyleSettingsResponse = z.infer<typeof StyleSettingsResponse>;

/** Body of PUT /api/admin/style-settings: the fields to change. */
export const StyleSettingsRequest = z.strictObject({ rewrite: z.boolean().optional() });
export type StyleSettingsRequest = z.infer<typeof StyleSettingsRequest>;

export const StyleFlagStat = z.strictObject({
  /** null = narration (no NPC). */
  npc: z.strictObject({ id: z.string(), alias: z.string() }).nullable(),
  /** A ForbiddenRule id of the Voice set, `pronoun_mismatch` or `never_word`. */
  reason: z.string(),
  count: z.number().int().min(1),
});
export type StyleFlagStat = z.infer<typeof StyleFlagStat>;

/** 200 from GET /api/admin/style-flags: most flagged first. */
export const StyleFlagsResponse = z.strictObject({ stats: z.array(StyleFlagStat) });
export type StyleFlagsResponse = z.infer<typeof StyleFlagsResponse>;
