import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * A move that completes when the current turn closes (GEN-066): `arrive` = a trip to another zone (the
 * turn was the trip), `return` = back from one turn in the Astral Rift. `location_id` is what the
 * character's presence becomes. At most one per character.
 */
export const travelPending = sqliteTable(
  'travel_pending',
  {
    memberId: text('member_id')
      .primaryKey()
      .references(() => member.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    locationId: text('location_id').notNull(),
    kind: text('kind', { enum: ['arrive', 'return'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('travel_pending_game').on(t.gameId)],
);
