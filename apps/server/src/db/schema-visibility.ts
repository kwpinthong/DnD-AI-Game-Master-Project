import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * Where a character is (GEN-050). Made for every character when the game starts; no row = not placed
 * yet, so nobody sees them. `ref` is the opaque handle other players see instead of the member id.
 * `location_id` is a scenario location id; only the engine moves it (`moveCharacter`).
 */
export const characterPresence = sqliteTable(
  'character_presence',
  {
    memberId: text('member_id')
      .primaryKey()
      .references(() => member.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull().unique(),
    locationId: text('location_id').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('character_presence_game_location').on(t.gameId, t.locationId)],
);

/**
 * Real names one character knows (GEN-050): per viewer, so B introducing itself to A tells A only.
 * `how`: `introduced` (the subject told them) or `discovered` (found out, สืบรู้).
 */
export const knownName = sqliteTable(
  'known_name',
  {
    viewerMemberId: text('viewer_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    subjectMemberId: text('subject_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    how: text('how', { enum: ['introduced', 'discovered'] }).notNull(),
    learnedAt: integer('learned_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.viewerMemberId, t.subjectMemberId] })],
);

/**
 * One player's bond with one scenario NPC (GEN-050 stores it; GEN-054 changes affinity).
 * `name_revealed` stays true once set, even if affinity drops later (Rules Spec §8.1).
 */
export const npcBond = sqliteTable(
  'npc_bond',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    affinity: integer('affinity').notNull().default(0),
    nameRevealed: integer('name_revealed', { mode: 'boolean' }).notNull().default(false),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.npcId] })],
);
