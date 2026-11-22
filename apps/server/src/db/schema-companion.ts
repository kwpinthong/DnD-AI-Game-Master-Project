import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/** `Period` of `@isekai/rules`; written out because drizzle-kit loads this file alone. */
const PERIODS = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

/**
 * The opaque handle players use for a scenario NPC in one game (GEN-054). Scenario ids such as
 * `cult-leader` give the role away, so players only ever see `ref`. Made on first use.
 */
export const npcRef = sqliteTable(
  'npc_ref',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    ref: text('ref').notNull().unique(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.npcId] })],
);

/**
 * A story flag the AI GM set for one player and one NPC (GEN-054): the event half of an Evolution / Unlock
 * Condition ("ปกป้องชาวบ้านในวันที่ 7"). `count` grows each time it is set ("ครบ 3 ครั้ง").
 */
export const npcFlag = sqliteTable(
  'npc_flag',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    flag: text('flag').notNull(),
    count: integer('count').notNull().default(1),
    /** Game day it was last set. */
    day: integer('day').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.npcId, t.flag] })],
);

/** A period in which the player did something together with the NPC (ลูเซีย: 3 distinct periods a day). */
export const npcActivity = sqliteTable(
  'npc_activity',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    day: integer('day').notNull(),
    period: text('period', { enum: PERIODS }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.npcId, t.day, t.period] })],
);

/** Lowest / highest karma the companion functions saw for a player on one game day ("กรรม -1..+1 ตลอด"). */
export const karmaDay = sqliteTable(
  'karma_day',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    min: integer('min').notNull(),
    max: integer('max').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.day] })],
);

/** A reward from the NPC's Rewards & Abilities cell that the player got (each once). Read by the inventory (GEN-055). */
export const npcReward = sqliteTable(
  'npc_reward',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    npcId: text('npc_id').notNull(),
    /** Ability name or Item English name, as in the sheet. */
    reward: text('reward').notNull(),
    kind: text('kind', { enum: ['skill', 'item'] }).notNull(),
    grantedAt: integer('granted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.npcId, t.reward] })],
);
