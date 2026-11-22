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
 * Alliance and relationship between two players of one game (GEN-067). One row per pair, stored with
 * `member_low` < `member_high` so A-B and B-A are the same row: an alliance is mutual. `relationship` runs
 * -100..+100. Only the AI GM / engine writes it (`setPlayerBond`); no player route changes it.
 */
export const playerBond = sqliteTable(
  'player_bond',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberLow: text('member_low')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    memberHigh: text('member_high')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    alliance: integer('alliance', { mode: 'boolean' }).notNull().default(false),
    relationship: integer('relationship').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberLow, t.memberHigh] }), index('player_bond_game').on(t.gameId)],
);

/**
 * Hidden Evidence Tag (GEN-067, sheet Fog of War): a Secret action leaves one at its place for that game
 * day. Keyed on the day only (not the phase / period), so it outlives any change to how a day is split.
 * Players never list it; INVESTIGATE at the place on the same day may find it (`discoverHiddenEvidence`).
 */
export const hiddenEvidence = sqliteTable(
  'hidden_evidence',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    locationId: text('location_id').notNull(),
    day: integer('day').notNull(),
    actorMemberId: text('actor_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('hidden_evidence_place_day').on(t.gameId, t.locationId, t.day)],
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
    // --- GEN-054 (companions + evolution; see companions/store.ts) ---
    /** Save order when this NPC is one of the player's (at most 3) companions; null = not saved. */
    companionSeq: integer('companion_seq'),
    /** The NPC's grade for this player once it evolved (F → SS, A → S, S awakened = S); null = not evolved. */
    evolvedGrade: text('evolved_grade', { enum: ['S', 'SS'] }),
    /** Which path it took ("สาย Good" / "Evil" / "Neutral" of the sheet); null = the NPC's only path. */
    evolvedAlignment: text('evolved_alignment', { enum: ['Good', 'Evil', 'Neutral'] }),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.npcId] })],
);
