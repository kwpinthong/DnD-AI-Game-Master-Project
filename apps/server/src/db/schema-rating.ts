import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * What members say about a game after it ended (GEN-078, ADR GEN-077 "Learning Across Games"). Both tables
 * stay with their game (cascade); the learning gate (GEN-079) reads them live.
 * `game_rating`: one row per member, a resend replaces it. `score` is an integer 1..10.
 */
export const gameRating = sqliteTable(
  'game_rating',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    /** ≤ 500 characters, '' = none. */
    comment: text('comment').notNull().default(''),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.memberId] })],
);

/**
 * A member's 👍 on one ruling (an action → result row of the end page). `source_ref` is
 * `${day}-${phase}-${turn}-${actionSeq}`; the row exists = the 👍 is on, so one member counts once.
 * GEN-171: no longer read or written; migration 0038 copied every row into `response_vote` as
 * `ruling-${source_ref}` = 'up'. The table stays (additive migrations only).
 */
export const rulingVote = sqliteTable(
  'ruling_vote',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    sourceRef: text('source_ref').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.memberId, t.sourceRef] })],
);

/**
 * GEN-107: a member's 👍 / 👎 on one AI-written room entry during play (and after). `source_ref` is
 * `entry-${room_entry.id}` (the response id), or `ruling-${day}-${phase}-${turn}-${actionSeq}` for a ruling of
 * the end page (GEN-171, Q-325); the row exists = a vote, cancelling deletes it, so a member
 * has at most one per entry. Kept per game for learning (the counts are not sent to players).
 */
export const responseVote = sqliteTable(
  'response_vote',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    sourceRef: text('source_ref').notNull(),
    vote: text('vote', { enum: ['up', 'down'] }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.memberId, t.sourceRef] })],
);
