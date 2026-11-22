import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game } from './schema.ts';

/**
 * The opaque handle players use for a scenario NPC in one game (GEN-054). Scenario ids such as
 * `cult-leader` give the role away, so players only ever see `ref`. Made on first use.
 */
export const npcRef = sqliteTable(
  'npc_ref',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    ref: text('ref').notNull().unique(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.npcId] })],
);
