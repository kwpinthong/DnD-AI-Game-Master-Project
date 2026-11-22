import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game } from './schema.ts';

/**
 * How a game ended (GEN-059). Written in the same transaction as the turn that ended the game (status
 * `finale` / `game_over`), so the decision never changes afterwards; the AI narration of the ending comes
 * later and may fail (`narrated_at` stays null and the room offers retry).
 * - `path`: the ending path (`good` / `evil` / `neutral`), or `none` = no path succeeded (the meteor hits).
 * - `outcomes`: memberId → `survived` | `defeated`, for every player of the game at the end.
 */
export const gameEnding = sqliteTable('game_ending', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => game.id, { onDelete: 'cascade' }),
  reason: text('reason', { enum: ['finale', 'game_over'] }).notNull(),
  path: text('path', { enum: ['good', 'evil', 'neutral', 'none'] }).notNull(),
  outcomes: text('outcomes', { mode: 'json' }).$type<Record<string, 'survived' | 'defeated'>>().notNull(),
  narratedAt: integer('narrated_at'),
  createdAt: integer('created_at').notNull(),
});
