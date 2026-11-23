import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { character, game, member } from './schema.ts';

/**
 * ISK-015: a player who joined after the start (no row = joined before it). `joined_turn` / `spawned_turn` are
 * `turnNumber`s of the game; `spawned_turn` stays null while they make their character. The row goes with the
 * member when they are dropped for not spawning in time.
 */
export const lateJoin = sqliteTable(
  'late_join',
  {
    memberId: text('member_id')
      .primaryKey()
      .references(() => member.id, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    joinedTurn: integer('joined_turn').notNull(),
    spawnedTurn: integer('spawned_turn'),
  },
  (t) => [index('late_join_game').on(t.gameId)],
);

/**
 * Each character's start scenario (GEN-065 on GEN-049's table, GDD §6.1, sheet Start_Scenarios), rolled
 * once inside the game-start transaction so a restart never rolls again (C6). Only the owner (and the Human
 * GM) ever reads its row.
 * - `tier_id` / `kind`: the scenario origin tier that came up (standard 70 / special 29 / secret 1).
 * - `spawn_point_id` / `location_id`: the scenario spawn point and its place (a scenario location id).
 * - `start_scenario`: the Start_Scenarios Name the spawn point stands for; null when the data has no row.
 * - `illness_left`: chronic illness (คุณชาย/คุณหนูขี้โรค): successful treatments still needed, 0 = cured;
 *   null = never ill.
 * - `knows_day12_secret` / `curse_resist_rank`: the Astral Rift start (รู้ความลับวันที่ 12, ต้านคำสาประดับ B).
 * - `narration`: the private AI telling of the crossing; null until the AI wrote it.
 */
export const characterOrigin = sqliteTable(
  'character_origin',
  {
    memberId: text('member_id')
      .primaryKey()
      .references(() => character.memberId, { onDelete: 'cascade' }),
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    tierId: text('tier_id').notNull(),
    kind: text('kind', { enum: ['standard', 'special', 'secret'] }).notNull(),
    spawnPointId: text('spawn_point_id').notNull(),
    locationId: text('location_id').notNull(),
    startScenario: text('start_scenario'),
    illnessLeft: integer('illness_left'),
    knowsDay12Secret: integer('knows_day12_secret', { mode: 'boolean' }).notNull().default(false),
    curseResistRank: text('curse_resist_rank', { enum: ['F', 'B', 'A', 'S', 'SS'] }),
    narration: text('narration'),
    narratedAt: integer('narrated_at'),
    rolledAt: integer('rolled_at').notNull(),
  },
  (t) => [index('character_origin_game').on(t.gameId)],
);
