import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/** `Phase` of `@isekai/protocol` (periods, GEN-063); written out because drizzle-kit loads this file alone. */
const PHASES = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

/**
 * The Human GM's override log (GEN-058 C5): every change the GM made, with who, what and why. GM-only:
 * never sent to a player. Edits of a held turn (`narration` / `result`) are also what the approval reads
 * back, so a restart before the approval keeps them (the turn is resolved again from the AI GM's stored work).
 * - `day` / `phase` / `turn`: the held turn for turn edits, otherwise the turn the game was at.
 * - `before` / `after`: JSON.
 */
export const gmOverride = sqliteTable(
  'gm_override',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    gmMemberId: text('gm_member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['narration', 'result', 'adjust', 'event'] }).notNull(),
    day: integer('day').notNull(),
    phase: text('phase', { enum: PHASES }).notNull(),
    turn: integer('turn').notNull(),
    target: text('target').notNull(),
    before: text('before').notNull(),
    after: text('after').notNull(),
    reason: text('reason').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('gm_override_game_turn').on(t.gameId, t.day, t.phase, t.turn)],
);
