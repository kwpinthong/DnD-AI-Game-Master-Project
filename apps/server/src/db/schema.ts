import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Times are Unix epoch milliseconds (integer).

/** Key/value facts about this database (e.g. when it was created). */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * A game players join with its invite code. `invite_code` is stored normalised: upper-case, no
 * spaces or dashes; the owner can replace it (the old code stops working).
 */
export const game = sqliteTable('game', {
  id: text('id').primaryKey(),
  inviteCode: text('invite_code').notNull().unique(),
  name: text('name').notNull().default(''),
  /** 'online' (2-6 players) or 'single' (1 player). */
  mode: text('mode', { enum: ['online', 'single'] }).notNull().default('online'),
  /** The creator is a Human GM (no character, not a player). Single games never have one. */
  humanGm: integer('human_gm', { mode: 'boolean' }).notNull().default(false),
  /** The member who created the game; only they may kick, edit, renew the code or start. */
  ownerMemberId: text('owner_member_id'),
  /** Set once by the start; mode and members are locked from then on. */
  startedAt: integer('started_at'),
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
    /** 'gm' only for the Human GM (the creator of a game with one). */
    role: text('role', { enum: ['player', 'gm'] }).notNull().default('player'),
    /** Set when the owner kicks the member: sessions are gone and the name cannot join again. */
    kickedAt: integer('kicked_at'),
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

/**
 * Each game's own copy of its scenario (GEN-045), made from the template when the game is created.
 * `data` is the Scenario JSON of `@isekai/protocol`; always read it back through `parseScenario`.
 */
export const gameScenario = sqliteTable('game_scenario', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => game.id, { onDelete: 'cascade' }),
  schemaVersion: integer('schema_version').notNull(),
  data: text('data').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * A player's character: one per member, so one per player per game (the Human GM has none).
 * GEN-025 created the row as the "has a character" marker for the start check; GEN-047 adds the
 * identity (GDD §2) and the stats. The stats start at STARTING_STATS and only the engine changes
 * them; `karma` and `reputation` are never sent to players (they see the Social Title).
 */
export const character = sqliteTable('character', {
  memberId: text('member_id')
    .primaryKey()
    .references(() => member.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  // --- GEN-047 (migration 0005_character) ---
  name: text('name').notNull().default(''),
  appearance: text('appearance').notNull().default(''),
  personality: text('personality').notNull().default(''),
  hp: integer('hp').notNull().default(100),
  hpMax: integer('hp_max').notNull().default(100),
  stamina: integer('stamina').notNull().default(30),
  staminaMax: integer('stamina_max').notNull().default(30),
  reputation: integer('reputation').notNull().default(0),
  karma: integer('karma').notNull().default(0),
  updatedAt: integer('updated_at'),
});

// GEN-038: AI usage lives in its own file so parallel schema work merges cleanly.
export * from './schema-ai.ts';

// GEN-053: timeline event state, own file for the same reason.
export * from './schema-timeline.ts';

// GEN-048: the character loot step, own file for the same reason.
export * from './schema-loot.ts';

// GEN-050: who is where and who knows whose name, own file for the same reason.
export * from './schema-visibility.ts';

// GEN-056: the play room (phase state, actions, feed / narration), own file for the same reason.
export * from './schema-room.ts';

// GEN-060: items that changed hands between players, own file for the same reason.
export * from './schema-items.ts';

// GEN-064: Active skill / item uses per game day (Daily_Limit), own file for the same reason.
export * from './schema-tags.ts';
// GEN-054: NPC handles for companions, own file for the same reason.
export * from './schema-companion.ts';

// GEN-057: the AI GM turn loop (stored turn work, Constraint Lock, day memory), own file for the same reason.
export * from './schema-gm.ts';

// GEN-066: a trip that ends when the turn closes, own file for the same reason.
export * from './schema-travel.ts';

// GEN-058: the Human GM's override log, own file for the same reason.
export * from './schema-gm-console.ts';
