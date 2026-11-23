import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * GEN-167: one round of the Thai style eval set (`pnpm eval:style`). Not tied to any game. `scenes` = JSON of each
 * scene's result with the prompt it was sent; `marks` = JSON sceneId → better / same / worse against the round before.
 */
export const styleEvalRun = sqliteTable('style_eval_run', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: integer('created_at').notNull(),
  provider: text('provider').notNull(),
  /** JSON string[] of the models that answered. */
  models: text('models').notNull(),
  /** The Voice data set's `version` (the style guide) of this round. */
  voiceVersion: integer('voice_version').notNull(),
  costUsdMicros: integer('cost_usd_micros').notNull(),
  scenes: text('scenes').notNull(),
  marks: text('marks').notNull().default('{}'),
});
