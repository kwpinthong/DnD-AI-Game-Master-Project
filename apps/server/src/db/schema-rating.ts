import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
    /** GEN-168: JSON array of `VoteReason`, only with `down` ('[]' otherwise and on every vote older than the column). */
    reasons: text('reasons').notNull().default('[]'),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.memberId, t.sourceRef] })],
);

/**
 * GEN-168: the server owner's "แก้เป็น" pairs: an AI message as the game kept it and the version it should have
 * been. Append-only (each save is a new row, never changed), so the table is also the audit of the edits. No
 * foreign keys and a snapshot of the text / NPC / scene: a pair outlives its game for fine-tuning.
 * `library_candidate`: marked for the NPC example library, which GEN-151 builds.
 */
export const responseCorrection = sqliteTable(
  'response_correction',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id').notNull(),
    entryId: integer('entry_id').notNull(),
    original: text('original').notNull(),
    edited: text('edited').notNull(),
    npcName: text('npc_name'),
    scene: text('scene', { enum: ['feed', 'narration', 'npc-dialogue', 'npc-reaction'] }).notNull(),
    /** JSON array of `VoteReason`. */
    reasons: text('reasons').notNull().default('[]'),
    /** JSON array of the game's players' real names when saved, so the export can swap them for tokens later. */
    playerNames: text('player_names').notNull().default('[]'),
    libraryCandidate: integer('library_candidate', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('response_correction_entry').on(t.gameId, t.entryId)],
);

/**
 * GEN-189: what a deleted game's 👍/👎 said, kept for fine-tuning. Written just before the game is deleted (its
 * response_vote rows cascade): one row per voted AI message, `text` with players' names as `{{PLAYER_n}}` (no real
 * or lobby name is stored), the counts and verdict out of `players` as GEN-126 counts them. No foreign keys.
 */
export const voteSnapshot = sqliteTable('vote_snapshot', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameId: text('game_id').notNull(),
  entryId: integer('entry_id').notNull(),
  scene: text('scene', { enum: ['feed', 'narration', 'npc-dialogue', 'npc-reaction'] }).notNull(),
  npcName: text('npc_name'),
  text: text('text').notNull(),
  up: integer('up').notNull(),
  down: integer('down').notNull(),
  players: integer('players').notNull(),
  verdict: text('verdict', { enum: ['good', 'avoid', 'none'] }).notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * GEN-151: the NPC example library. A 👍 message or a "แก้เป็น" pair's edited text given to one NPC, with a scene
 * kind. `text` holds tokens only (`{{n:id}}`, `{{p:player}}`). No foreign keys: an example outlives its game.
 * `correction_id`: the pair it came from (source `correction`).
 */
export const npcExample = sqliteTable(
  'npc_example',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    npcId: text('npc_id').notNull(),
    /** The NPC's real name when added, for the owner's page only (never a prompt). */
    npcName: text('npc_name').notNull(),
    scene: text('scene', { enum: ['feed', 'narration', 'npc-dialogue', 'npc-reaction'] }).notNull(),
    text: text('text').notNull(),
    source: text('source', { enum: ['vote', 'correction'] }).notNull(),
    gameId: text('game_id').notNull(),
    entryId: integer('entry_id').notNull(),
    correctionId: integer('correction_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('npc_example_npc').on(t.npcId)],
);
