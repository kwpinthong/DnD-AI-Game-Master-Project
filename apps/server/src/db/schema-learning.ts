import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * ADR "Learning Across Games" (GEN-077, Revised GEN-108): what the AI GM keeps from ended games. No foreign keys
 * (an entry outlives its game; the game name and score are snapshots). One row per `source_game_id + type +
 * source_ref` (the idempotent key): `lore-1..5` / `feedback` (GEN-080). `status`: `active` is used,
 * `suspended` is kept but not used. `content` never holds a lobby name or a player code.
 */
export const learningEntry = sqliteTable(
  'learning_entry',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    sourceGameId: text('source_game_id').notNull(),
    sourceGameName: text('source_game_name').notNull(),
    /** The game's average rating when extracted; null = nobody had rated (display and sorting only, never a gate). */
    sourceScore: real('source_score'),
    sourceRef: text('source_ref').notNull(),
    content: text('content').notNull(),
    /** JSON string[] (lower-case tags). */
    tags: text('tags').notNull().default('[]'),
    /** JSON, per type. */
    detail: text('detail').notNull().default('{}'),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('learning_entry_key').on(t.sourceGameId, t.type, t.sourceRef), index('learning_entry_type_status').on(t.type, t.status)],
);

/** GEN-080: one row per game once the lore / feedback extract ran: `done` (never again) or `failed` (the owner may retry). */
export const learningExtract = sqliteTable('learning_extract', {
  gameId: text('game_id').primaryKey(),
  status: text('status', { enum: ['done', 'failed'] }).notNull(),
  /** The failure kind (no prompt text). */
  error: text('error'),
  updatedAt: integer('updated_at').notNull(),
});
