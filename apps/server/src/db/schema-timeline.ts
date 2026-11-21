import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game } from './schema.ts';

/**
 * Where a game is on its 12-day timeline (GEN-053). Moves forward only, through `advanceTimeline`.
 * No row = the game has not reached day 1 Morning yet. `ended` = past day 12 Night (finale).
 */
export const gameTimeline = sqliteTable('game_timeline', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => game.id, { onDelete: 'cascade' }),
  day: integer('day').notNull(),
  phase: text('phase', { enum: ['MORNING', 'AFTERNOON', 'NIGHT'] }).notNull(),
  ended: integer('ended', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Runtime state of one scenario event in one game (GEN-053). The event itself (day, phase, title,
 * ผลตั้งต้น) stays in `game_scenario`; this table holds only what changes during play.
 * `outcome` is the AI's choice while active, then the final outcome once resolved (the scenario's
 * default when nobody stepped in). Kept apart from `game_scenario` so scenario edits never touch it.
 */
export const gameEventState = sqliteTable(
  'game_event_state',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    status: text('status', { enum: ['pending', 'active', 'resolved'] }).notNull(),
    outcome: text('outcome'),
    outcomeSource: text('outcome_source', { enum: ['default', 'ai'] }),
    activatedAt: integer('activated_at'),
    resolvedAt: integer('resolved_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.eventId] })],
);
