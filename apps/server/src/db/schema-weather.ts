import { PERIODS as PHASES, WEATHERS } from '@isekai/rules';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { game } from './schema.ts';

/**
 * The weather of each period of a game (GEN-068), picked once when the period opens and never again:
 * a restart reads it from here instead of asking the AI (C7). `disaster` holds from day 5 on.
 */
export const periodWeather = sqliteTable(
  'period_weather',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => game.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    phase: text('phase', { enum: PHASES }).notNull(),
    weather: text('weather', { enum: WEATHERS }).notNull(),
    disaster: integer('disaster', { mode: 'boolean' }).notNull(),
    /** `ai`: the AI's first answer; `repair`: its answer after one repair; `fallback`: Clear (still wrong, or the AI failed). */
    source: text('source', { enum: ['ai', 'repair', 'fallback'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.day, t.phase] })],
);
