import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/** `Phase` of `@isekai/protocol` (periods, GEN-063); written out because drizzle-kit loads this file alone. */
const PHASES = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

/**
 * The play room (GEN-056). `game_phase.state` is the `PhaseState` JSON of `@isekai/rules` (GEN-052, period +
 * turn since GEN-063): the engine is a pure function, so its whole state is stored and replaced on every step.
 */
export const gamePhase = sqliteTable('game_phase', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => game.id, { onDelete: 'cascade' }),
  state: text('state').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Every action that stood when its turn closed (and the current turn's drafts); a resubmit replaces. */
export const phaseAction = sqliteTable(
  'phase_action',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    /** The period. */
    phase: text('phase', { enum: PHASES }).notNull(),
    /** 1 | 2 within the period. */
    turn: integer('turn').notNull().default(1),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    visibility: text('visibility', { enum: ['public', 'secret'] }).notNull(),
    /** REST / SLEEP this turn (GEN-063). */
    rest: integer('rest', { mode: 'boolean' }).notNull().default(false),
    submittedAt: integer('submitted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.day, t.phase, t.turn, t.memberId] })],
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
    kind: text('kind', { enum: ['feed', 'narration', 'whisper'] }).notNull(),
    day: integer('day').notNull(),
    phase: text('phase', { enum: PHASES }).notNull(),
    turn: integer('turn').notNull().default(1),
    /** Scenario location id; null = the whole town (feed) or no place (narration). */
    locationId: text('location_id'),
    text: text('text').notNull(),
    /**
     * Whisper only (GEN-067): sender and target member ids; null for feed / narration. No foreign key:
     * SQLite cannot add a column with ON DELETE CASCADE, and the row goes with its game anyway.
     */
    fromMemberId: text('from_member_id'),
    toMemberId: text('to_member_id'),
    /** Q-177: why this text is the server template (null = the AI GM's own text). Players see only that it is one. */
    fallback: text('fallback', { enum: ['timeout', 'budget', 'invalid', 'error'] }),
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
