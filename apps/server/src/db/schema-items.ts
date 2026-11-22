import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * Items that changed hands between players (GEN-060: steal / give). An item stays defined by the
 * loot row of the character who chose it (`character_loot`, GEN-048); a row here only says who
 * holds it now. No row = still with its first owner. The full inventory (GEN-055) replaces this.
 */
export const itemHolder = sqliteTable(
  'item_holder',
  {
    itemId: text('item_id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    holderMemberId: text('holder_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('item_holder_game').on(t.gameId)],
);
