import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game, member } from './schema.ts';

/** `Period` of `@isekai/rules`; written out because drizzle-kit loads this file alone. */
const PERIODS = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

/**
 * Skills and items beyond the loot step (GEN-055). A player's skills are the loot skill (character_loot),
 * the NPC rewards (npc_reward) and the rows here; nothing in these tables is ever sent to a player except
 * the conditions they revealed at the library (`skill_reveal`).
 */

/** A skill the player unlocked by its Condition (or an item's Skill Synergy). Each skill once per player. */
export const ownedSkill = sqliteTable(
  'owned_skill',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    /** Ability name, as in the sheet. */
    name: text('name').notNull(),
    /** Which unlock path gave it: `condition` or `item:<Item English name>`. */
    source: text('source').notNull(),
    day: integer('day').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.name] }), index('owned_skill_game').on(t.gameId)],
);

/** A period in which the player did an activity the unlock rules count (`verb:PRAY`, `evil`, `karma_steady`, ...). */
export const skillActivity = sqliteTable(
  'skill_activity',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    activity: text('activity').notNull(),
    day: integer('day').notNull(),
    period: text('period', { enum: PERIODS }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.activity, t.day, t.period] })],
);

/** An event of a condition only the AI GM can judge ("ปกป้องผู้อื่นสำเร็จ 3 ครั้ง"); `count` grows each time. */
export const skillFlag = sqliteTable(
  'skill_flag',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    flag: text('flag').notNull(),
    count: integer('count').notNull(),
    day: integer('day').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.flag] })],
);

/** A condition the player found with INVESTIGATE at the library (the only condition a player may read). */
export const skillReveal = sqliteTable(
  'skill_reveal',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['skill', 'item'] }).notNull(),
    /** Ability name or Item English name. */
    name: text('name').notNull(),
    day: integer('day').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.kind, t.name] })],
);

/** The player's karma when a period's first turn closed, to tell whether the period ended with it unchanged. */
export const periodKarma = sqliteTable(
  'period_karma',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    period: text('period', { enum: PERIODS }).notNull(),
    start: integer('start').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.day, t.period] })],
);
