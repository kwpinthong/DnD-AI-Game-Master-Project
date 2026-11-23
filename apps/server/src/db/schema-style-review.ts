import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * GEN-178: the style review rounds and the rules they proposed. No foreign keys (a round is server-wide, not a
 * game's). A `done` round "uses" its signals: the next one counts 👎 voted after `to_at` and the flags above
 * `flag_snapshot`; a `skipped` or `failed` round uses nothing, so its signals wait for the next.
 */
export const styleReviewRound = sqliteTable('style_review_round', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trigger: text('trigger', { enum: ['games', 'manual'] }).notNull(),
  status: text('status', { enum: ['done', 'skipped', 'failed'] }).notNull(),
  signals: integer('signals').notNull(),
  /** JSON `StyleSignalCounts`. */
  counts: text('counts').notNull(),
  /** 👎 with `updated_at` up to this time are counted by this round. */
  toAt: integer('to_at').notNull(),
  /** JSON `{ "<npcId>|<rule>": count }`: the checker's running flag counts when the round started. */
  flagSnapshot: text('flag_snapshot').notNull(),
  /** JSON `[{ summary, evidence }]` from the AI. */
  patterns: text('patterns').notNull().default('[]'),
  /** The failure kind (no prompt text). */
  error: text('error'),
  createdAt: integer('created_at').notNull(),
});

export const styleRuleProposal = sqliteTable(
  'style_rule_proposal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roundId: integer('round_id').notNull(),
    kind: text('kind', { enum: ['forbid', 'pair', 'npc_patch'] }).notNull(),
    npcId: text('npc_id'),
    /** JSON, checked against the Voice schema of its kind (the approved edit replaces it). */
    content: text('content').notNull(),
    reason: text('reason').notNull(),
    /** JSON array of room entry ids. */
    evidence: text('evidence').notNull().default('[]'),
    status: text('status', { enum: ['proposed', 'approved', 'rejected'] }).notNull(),
    voiceVersion: integer('voice_version'),
    decidedAt: integer('decided_at'),
  },
  (t) => [index('style_rule_proposal_round').on(t.roundId)],
);
