import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game } from './schema.ts';

/** `Phase` of `@isekai/protocol` (periods, GEN-063); written out because drizzle-kit loads this file alone. */
const PHASES = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

/**
 * Where a game is on its 12-day timeline (GEN-053). Moves forward only, through `advanceTimeline`.
 * No row = the game has not reached day 1 EOSORIA yet. `ended` = past day 12 NOCTHERION (finale).
 * Period granularity: an event is active for both turns of its period, so the cursor has no turn.
 */
export const gameTimeline = sqliteTable('game_timeline', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => game.id, { onDelete: 'cascade' }),
  day: integer('day').notNull(),
  phase: text('phase', { enum: PHASES }).notNull(),
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
    /**
     * Members at the event's place when it left `pending` (Q-104): the snapshot `witnessesOf` takes, so
     * they keep seeing it after moving away and someone who arrives later never does. Null = no
     * snapshot: a town-wide event, or one that began before migration 0011 (players then see it by
     * where they are now, the Q-080 rule).
     */
    witnesses: text('witnesses', { mode: 'json' }).$type<string[]>(),
    /**
     * GEN-059, the finale event only: the ending path the AI GM says the players completed while it is
     * active (`endingPath` of the turn proposal); null = none (yet). The last one set stands.
     */
    endingPath: text('ending_path', { enum: ['good', 'evil', 'neutral'] }),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.eventId] })],
);
