import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * Who took part in which Day10_Strategies plan on the night of day 10 (GEN-093, Q-203), one row per player
 * and plan: the role the AI GM gave (leader / support) and whether that player's action succeeded. A player
 * who acts in both turns of the night keeps one row: a leader turn replaces a support turn, a later turn in
 * the same role replaces the earlier one. Server-only: no player API reads it before the game ends.
 */
export const strategyParticipant = sqliteTable(
  'strategy_participant',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    strategyId: text('strategy_id').notNull(),
    role: text('role', { enum: ['leader', 'support'] }).notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    day: integer('day').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.memberId, t.strategyId] })],
);

/**
 * How each plan of the game ended, written once when the strategy event (day 10 NOCTHERION) resolves: a plan
 * succeeds when one of its leaders succeeded, else it failed. When no plan succeeded (nobody ran one, or all
 * failed) the game also gets the `D10-DRIFT` row with outcome `drift`.
 */
export const strategyOutcome = sqliteTable(
  'strategy_outcome',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    strategyId: text('strategy_id').notNull(),
    outcome: text('outcome', { enum: ['success', 'failed', 'drift'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.strategyId] })],
);
