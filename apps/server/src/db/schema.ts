import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Times are Unix epoch milliseconds (integer).

/** Key/value facts about this database (e.g. when it was created). */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * A game players join with its invite code. GEN-024 needs only the lookup; GEN-025 (create game)
 * adds the rest. `invite_code` is stored normalised: upper-case, no spaces or dashes.
 */
export const game = sqliteTable('game', {
  id: text('id').primaryKey(),
  inviteCode: text('invite_code').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});

/**
 * A player inside one game, identified by name + PIN. The same name in another game is another
 * member. `name` is the normalised display name; `name_key` (lower-case) decides uniqueness.
 */
export const member = sqliteTable(
  'member',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    /** `scrypt$N$r$p$<salt b64>$<hash b64>`; the PIN itself is never stored. */
    pinHash: text('pin_hash').notNull(),
    /** Set when the 5th wrong PIN in 10 minutes arrives; joins are refused until then. */
    lockedUntil: integer('locked_until'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('member_game_name_key').on(t.gameId, t.nameKey)],
);

/** Wrong PINs since the member's last successful join (cleared on success and on lock). */
export const pinFailure = sqliteTable(
  'pin_failure',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    at: integer('at').notNull(),
  },
  (t) => [index('pin_failure_member_at').on(t.memberId, t.at)],
);

/** A logged-in browser. Only the SHA-256 of the bearer token is stored. */
export const session = sqliteTable(
  'session',
  {
    tokenHash: text('token_hash').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('session_member').on(t.memberId)],
);
