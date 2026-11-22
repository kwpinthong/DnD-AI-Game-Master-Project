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
