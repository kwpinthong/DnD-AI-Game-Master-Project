import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * How often a member activated an Active skill / item on one game day (GEN-064, Daily_Limit).
 * Keyed by the day number only, so it survives a change of the phases inside a day (GEN-063).
 * A new day has no row = no uses yet. Passive sources are never counted.
 */
export const tagSourceUse = sqliteTable(
  'tag_source_use',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    /** The owned skill / item id (the loot option id). */
    sourceId: text('source_id').notNull(),
    day: integer('day').notNull(),
    uses: integer('uses').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.sourceId, t.day] }), index('tag_source_use_game').on(t.gameId)],
);
