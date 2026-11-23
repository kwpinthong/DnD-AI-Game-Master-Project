import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/**
 * GEN-149: one answered chat message to an NPC (outside the turn). The rows of a (member, day, phase) are the quota
 * used this period; the newest of a pair are the talk the NPC remembers. Texts are stored with name tokens.
 */
export const npcChat = sqliteTable(
  'npc_chat',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    day: integer('day').notNull(),
    phase: text('phase', { enum: ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] }).notNull(),
    whisper: integer('whisper', { mode: 'boolean' }).notNull().default(false),
    text: text('text').notNull(),
    reply: text('reply').notNull(),
    /** The affinity change the talk made (-1, 0, +1). */
    affinity: integer('affinity').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('npc_chat_member_period').on(t.memberId, t.day, t.phase)],
);
