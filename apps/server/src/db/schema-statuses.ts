import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game } from './schema.ts';

/**
 * Timed curses on a player or an NPC (GEN-095, Q-142): e.g. Venom of Despair "หวาดกลัว", d20 -3 for 2 periods.
 * One row per holder and source: casting the same curse again while it lasts resets its time and keeps its
 * value (Q-212). Turns are counted as one index over the game (`turnIndex`): the curse works on every turn
 * from `fromTurn` to `untilTurn`, both included, and is gone after (no clean-up needed, restart-safe).
 * `holderId` is a member id (player) or a scenario NPC id; no FK, the row goes with its game.
 */
export const gameStatus = sqliteTable(
  'game_status',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    holderKind: text('holder_kind', { enum: ['player', 'npc'] }).notNull(),
    holderId: text('holder_id').notNull(),
    /** The Ability / Item name that put it on. */
    source: text('source').notNull(),
    /** What the holder sees, e.g. "หวาดกลัว". */
    label: text('label').notNull(),
    /** d20 change on every roll of the holder (negative). */
    value: integer('value').notNull(),
    fromTurn: integer('from_turn').notNull(),
    untilTurn: integer('until_turn').notNull(),
    /** Member who cast it last. */
    castBy: text('cast_by'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.holderKind, t.holderId, t.source] }), index('game_status_game').on(t.gameId)],
);
