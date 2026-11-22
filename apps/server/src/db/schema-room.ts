import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * The play room (GEN-056). `game_phase.state` is the `PhaseState` JSON of `@isekai/rules` (GEN-052): the
 * day / phase engine is a pure function, so its whole state is stored and replaced on every step.
 */
export const gamePhase = sqliteTable('game_phase', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => game.id, { onDelete: 'cascade' }),
  state: text('state').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Every action that stood when its phase closed (and the current phase's drafts); a resubmit replaces. */
export const phaseAction = sqliteTable(
  'phase_action',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    phase: text('phase', { enum: ['MORNING', 'AFTERNOON', 'NIGHT'] }).notNull(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    visibility: text('visibility', { enum: ['public', 'secret'] }).notNull(),
    submittedAt: integer('submitted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.day, t.phase, t.memberId] })],
);

/**
 * A feed or narration entry. `id` is the `seq` players see: it only grows, so within one game it is a
 * sequence number and a reconnect asks for "after the last one I have" (C6).
 */
export const roomEntry = sqliteTable(
  'room_entry',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['feed', 'narration'] }).notNull(),
    day: integer('day').notNull(),
    phase: text('phase', { enum: ['MORNING', 'AFTERNOON', 'NIGHT'] }).notNull(),
    /** Scenario location id; null = the whole town (feed) or no place (narration). */
    locationId: text('location_id'),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('room_entry_game').on(t.gameId, t.id)],
);

/**
 * Who may receive an entry, fixed when it is published (`witnessesOf` with the place snapshot of that
 * moment, GEN-050): someone who arrives later never gets it, not even on replay.
 */
export const roomEntryRecipient = sqliteTable(
  'room_entry_recipient',
  {
    entryId: integer('entry_id')
      .notNull()
      .references(() => roomEntry.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.memberId] }), index('room_entry_recipient_member').on(t.memberId, t.entryId)],
);
