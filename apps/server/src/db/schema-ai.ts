import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One row per attempt to call the AI provider (GEN-038), including failed ones.
 * Read by the per-game monthly ceiling and the owner's usage dashboard (Q-058, GEN-061).
 * Holds metadata only: never prompt or answer text (Q-045), never a key.
 * `game_id` has no foreign key so usage survives a deleted game (the owner still paid for it).
 */
export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id').notNull(),
    /** 1..12 when the call belongs to a phase. */
    day: integer('day'),
    /** MORNING | AFTERNOON | NIGHT when known. */
    phase: text('phase'),
    /** AiPurpose: gm_adjudicate, narrate_player, ... */
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    /** The model that answered (a refusal fallback may differ from the one asked for). */
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /** Estimate from AiConfig.prices, in millionths of a USD. */
    costUsdMicros: integer('cost_usd_micros').notNull(),
    /** 1 = usable answer, 0 = failed attempt. */
    ok: integer('ok').notNull(),
    /** `<kind>: <detail>` when ok = 0, e.g. `timeout: timeout`, `schema_mismatch: verdict`. */
    failureReason: text('failure_reason'),
    /** 1 for the first try of a trigger, 2.. for retries. */
    attempt: integer('attempt').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('ai_usage_game_created').on(t.gameId, t.createdAt)],
);
