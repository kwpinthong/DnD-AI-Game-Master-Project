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
    /** GEN-128: the dialogue calls of the turn not done yet, JSON `DialogueJob[]`; null = none left (a restart redoes the rest). */
    dialogue: text('dialogue'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.day, t.phase, t.turn] })],
);

/**
 * GEN-144: the NPCs the last turn left lingering (`Linger` of gm/npc-lines.ts): each one acted on (`talked`) at
 * `location_id`, or still there past its schedule; `used` = turns already spent past it. Replaced as a whole when a
 * turn applies; an old game has no rows (nobody lingers). GM-only.
 */
export const npcLinger = sqliteTable(
  'npc_linger',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    locationId: text('location_id').notNull(),
    used: integer('used').notNull(),
    talked: integer('talked', { mode: 'boolean' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.npcId] })],
);

/**
 * GEN-146: what an NPC remembers of one player (gm/npc-memory.ts): one line per event that involved the NPC, made
 * from the resolve result. `text` is tokens ({{n:id}}) with the player as the NPC knows them (their look until
 * acquainted, never a real name). `summary` = older normal lines folded into one. `witnesses`: JSON member ids of
 * the players who saw it. GM-only.
 */
export const npcMemory = sqliteTable(
  'npc_memory',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    phase: text('phase', { enum: PHASES }).notNull(),
    text: text('text').notNull(),
    weight: text('weight', { enum: ['normal', 'important', 'summary'] }).notNull(),
    witnesses: text('witnesses').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('npc_memory_pair').on(t.gameId, t.memberId, t.npcId)],
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

/**
 * A player's own journal (ADR §6.3, Q-153): `day` = what that player saw on one game day, `saga` = their days
 * so far folded into one text (row per day it was folded through). Made only from the entries that player
 * received, tokens only, and fed only to that player's own narrations.
 */
export const gmJournal = sqliteTable(
  'gm_journal',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['day', 'saga'] }).notNull(),
    day: integer('day').notNull(),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.kind, t.day] }), index('gm_journal_game').on(t.gameId)],
);
