import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/** `Phase` of `@isekai/protocol` (periods, GEN-063); written out because drizzle-kit loads this file alone. */
const PHASES = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

/**
 * The AI GM's work on one turn (GEN-057), so a restart mid-resolve goes on from where it stopped instead of
 * asking the AI again or rolling again (C6):
 * - `adjudicated`: the validated proposal and every die are stored; narrations are added as each one passes.
 * - `applied`: written in the same transaction that applies the turn and opens the next one.
 * `proposal` holds tokens only ({{p:ref}} / {{n:id}}), never a real name (Q-045). GM-only: never sent to a player.
 */
export const gmTurn = sqliteTable(
  'gm_turn',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    phase: text('phase', { enum: PHASES }).notNull(),
    turn: integer('turn').notNull(),
    status: text('status', { enum: ['adjudicated', 'applied'] }).notNull(),
    /** The validated `GmTurnProposal` JSON. */
    proposal: text('proposal').notNull(),
    /** Every die of the turn in the order rolled (priority, roll-offs, actions), JSON number[]. */
    rolls: text('rolls').notNull(),
    /** Narrations that passed their checks, JSON `{ [audienceKey]: NarrationOut }`. */
    narrations: text('narrations').notNull().default('{}'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.day, t.phase, t.turn] })],
);

/**
 * Constraint Lock (GEN-057 C4): a limit the AI GM put on a player (jailed, tied up). It stays in every
 * turn's context until the AI releases it with a reason. GM-only.
 */
export const gmConstraint = sqliteTable(
  'gm_constraint',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    /** Token text, e.g. "ถูกขังในคุกใต้ป้อมยาม". */
    text: text('text').notNull(),
    reason: text('reason').notNull(),
    day: integer('day').notNull(),
    releasedDay: integer('released_day'),
    releaseReason: text('release_reason'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('gm_constraint_game').on(t.gameId, t.releasedDay)],
);

/**
 * AI GM memory (ADR §6.3): `day` = the recap of one game day, `saga` = everything before it folded into one
 * text (row per day it was folded through). Tokens only. GM-only.
 */
export const gmMemory = sqliteTable(
  'gm_memory',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['day', 'saga'] }).notNull(),
    day: integer('day').notNull(),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.kind, t.day] })],
);
