import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { character } from './schema.ts';

/**
 * The loot step of character creation (GEN-048, GDD §4.1): what the AI offered from the personality
 * and what the player kept. JSON columns hold `StoredOffer` / `StoredChosen` from game/loot.ts
 * (traits keep their scope and value, which players never see). Only the owner reads its row.
 */
export const characterLoot = sqliteTable('character_loot', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => character.memberId, { onDelete: 'cascade' }),
  /** The set on offer now; null after the choice. */
  offerJson: text('offer_json'),
  /** One strength, one weakness, one Common skill, one Common item; null until chosen. */
  chosenJson: text('chosen_json'),
  /** Successful rerolls (a failed AI call does not count, C5). */
  rerollsUsed: integer('rerolls_used').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});
