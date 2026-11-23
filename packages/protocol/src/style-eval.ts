import { z } from 'zod';

/**
 * GEN-167: the fixed Thai style eval set (`pnpm eval:style`), for the server owner only. Each round runs every scene
 * against the AI once; the admin page puts the previous round and the latest side by side and Nok marks each scene.
 * Scene texts use NPC tokens ({{n:id}}); the prompts are kept on the server, never sent here.
 */

export const StyleEvalMark = z.enum(['better', 'same', 'worse']);
export type StyleEvalMark = z.infer<typeof StyleEvalMark>;

export const StyleEvalSceneResult = z.strictObject({
  sceneId: z.string(),
  /** Thai title of the scene, e.g. "ทักทายเด็กขอทานที่น้ำพุ". */
  title: z.string(),
  /** The AiPurpose the scene exercises. */
  purpose: z.string(),
  ok: z.boolean(),
  /** What the AI wrote (null when the scene failed). */
  text: z.string().nullable(),
  /** `<kind>: <detail>` of the failure, or `budget` when the round stopped at its spend limit. */
  failure: z.string().nullable(),
  /** `real_name` = a real NPC name the reader should not know; the others are Voice rule ids (GEN-169). */
  flags: z.array(z.string()),
  costUsdMicros: z.number().int().min(0),
});
export type StyleEvalSceneResult = z.infer<typeof StyleEvalSceneResult>;

export const StyleEvalRun = z.strictObject({
  id: z.number().int(),
  createdAt: z.number().int(),
  provider: z.string(),
  /** The models that answered (narration / dialogue model, summary model). */
  models: z.array(z.string()),
  /** `version` of the Voice data set (style guide) the round used. */
  voiceVersion: z.number().int(),
  costUsdMicros: z.number().int().min(0),
  scenes: z.array(StyleEvalSceneResult),
});
export type StyleEvalRun = z.infer<typeof StyleEvalRun>;

/** 200 from GET /api/admin/style-eval and PUT /api/admin/style-eval/:runId/marks/:sceneId. */
export const StyleEvalResponse = z.strictObject({
  current: StyleEvalRun.nullable(),
  previous: StyleEvalRun.nullable(),
  /** sceneId → Nok's mark of `current` against `previous`. */
  marks: z.record(z.string(), StyleEvalMark),
  summary: z.strictObject({ better: z.number().int(), same: z.number().int(), worse: z.number().int(), unmarked: z.number().int() }),
});
export type StyleEvalResponse = z.infer<typeof StyleEvalResponse>;

/** Body of PUT /api/admin/style-eval/:runId/marks/:sceneId; null clears the mark. */
export const StyleEvalMarkRequest = z.strictObject({ mark: StyleEvalMark.nullable() });
export type StyleEvalMarkRequest = z.infer<typeof StyleEvalMarkRequest>;
