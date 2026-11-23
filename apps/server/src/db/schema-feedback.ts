import { FEEDBACK_PAGES, FEEDBACK_STATUSES, FEEDBACK_TYPES, PHASES } from '@isekai/protocol';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * ISK-010: players' bug reports / ideas. Kept for good: no foreign keys (a report outlives its game) and never
 * deleted. `text` is stored raw (trimmed); day / period / turn are the game's when it was sent (null before the
 * first turn). The member index serves the rate limit (rows of the last 10 minutes).
 */
export const feedback = sqliteTable(
  'feedback',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id').notNull(),
    memberId: text('member_id').notNull(),
    type: text('type', { enum: FEEDBACK_TYPES }).notNull(),
    text: text('text').notNull(),
    day: integer('day'),
    period: text('period', { enum: PHASES }),
    turn: integer('turn'),
    page: text('page', { enum: FEEDBACK_PAGES }).notNull(),
    userAgent: text('user_agent').notNull().default(''),
    status: text('status', { enum: FEEDBACK_STATUSES }).notNull().default('new'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('feedback_member_created').on(t.memberId, t.createdAt), index('feedback_created').on(t.createdAt)],
);

/** ISK-010: one row per status change by the server owner (append-only). */
export const feedbackAudit = sqliteTable('feedback_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  feedbackId: integer('feedback_id').notNull(),
  action: text('action', { enum: ['status'] }).notNull(),
  from: text('from', { enum: FEEDBACK_STATUSES }).notNull(),
  to: text('to', { enum: FEEDBACK_STATUSES }).notNull(),
  at: integer('at').notNull(),
});
