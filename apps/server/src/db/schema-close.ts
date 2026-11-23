import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * ISK-001: a game the server owner closed early, one row per game (the primary key makes a second close fail).
 * It is both the closed state and the owner's audit, so it has no foreign key: the row outlives a deleted game.
 * - `game_name`: the name at the close. `reason`: trimmed, null = none.
 * - `has_summary`: the game was being played (end page like a normal end); false = closed in the lobby / setup.
 */
export const gameClose = sqliteTable('game_close', {
  gameId: text('game_id').primaryKey(),
  gameName: text('game_name').notNull(),
  reason: text('reason'),
  hasSummary: integer('has_summary', { mode: 'boolean' }).notNull(),
  closedAt: integer('closed_at').notNull(),
});
