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

/**
 * ISK-018: the server owner's other changes to a game, one row each: `kick` (with the member) or `invite_code`
 * (a new code; the code itself is never stored here). No foreign key, like `game_close`.
 */
export const adminGameAudit = sqliteTable('admin_game_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  action: text('action', { enum: ['kick', 'invite_code'] }).notNull(),
  gameId: text('game_id').notNull(),
  memberId: text('member_id'),
  at: integer('at').notNull(),
});
