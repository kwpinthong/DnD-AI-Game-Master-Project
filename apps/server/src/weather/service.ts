import { FALLBACK_WEATHER, periodWeather as weatherOfPeriod, restorePhaseState, weatherChoices, weatherProblem, type Period, type PeriodWeather, type Weather } from '@isekai/rules';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AiService } from '../ai/core/service.ts';
import type { AiCallRequest } from '../ai/provider.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { gamePhase, periodWeather } from '../db/schema.ts';

/**
 * The weather of each period (GEN-068, Q-089). When a period opens the AI GM picks one weather from the
 * choices `weatherChoices` allows; a wrong answer gets one repair (Q-049), then Clear; a failed AI call is
 * Clear too, so the game never waits on the weather. The answer is stored per (game, day, period) and is
 * the same for everyone in the town; a restart reads it back and never asks the AI again (C7).
 *
 * Hooks for other tasks:
 * - GEN-057 (AI GM turn loop): `currentWeather(db, gameId)` for the turn context; the room also hands it to
 *   the resolver as `ClosedPhase.weather`. Pass it to tagging with `weatherTagging` (crossplayer/tags.ts).
 * - GEN-066 (travel): `PeriodWeather` of `@isekai/rules` is the injectable input; `disaster` = exits closed.
 */
export type WeatherSource = 'ai' | 'repair' | 'fallback';

export interface StoredWeather extends PeriodWeather {
  readonly source: WeatherSource;
}

export interface WeatherService {
  /** The period's weather: the stored one, or picked now (AI GM, repair once, else Clear) and stored. */
  ensure(gameId: string, at: { readonly day: number; readonly phase: Period }): Promise<StoredWeather>;
  /** Resolves once no pick is running (shutdown). */
  idle(): Promise<void>;
}

/** The stored weather of (game, day, period); null = not picked yet. */
export function weatherAt(db: DbOrTx, gameId: string, at: { readonly day: number; readonly phase: Period }): StoredWeather | null {
  const row = db
    .select({ weather: periodWeather.weather, disaster: periodWeather.disaster, source: periodWeather.source })
    .from(periodWeather)
    .where(and(eq(periodWeather.gameId, gameId), eq(periodWeather.day, at.day), eq(periodWeather.phase, at.phase)))
    .get();
  return row ?? null;
}

/** The weather of the game's current period; null before the game's room opened or before it is picked. */
export function currentWeather(db: DbOrTx, gameId: string): StoredWeather | null {
  const row = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get();
  return row ? weatherAt(db, gameId, restorePhaseState(JSON.parse(row.state))) : null;
}

/** Loose on purpose: a value outside the list must reach `weatherProblem` and get its one repair. */
const WeatherAnswer = z.object({ weather: z.string() });

const RULES_TEXT = [
  'You are the GM of a 12-day town game. Pick the weather of the period that just opened.',
  'Weathers: Clear (bright sun: Secret actions are harder), Rain (outdoor actions tire more, stealth is easier),',
  'Fog (low visibility, grade S NPCs are easier to meet), Dark Night (secret passages open, the Evil side is stronger),',
  'Clear Night (a calm night sky), Storm.',
  'EOSORIA and SOLARION are daytime: never pick a night weather for them. Disaster is not a weather: the server adds it from day 5.',
  'Answer JSON {"weather": "<one of the allowed values>"}.',
].join('\n');

export function createWeatherService(db: Db, ai: AiService, now: () => number, log: (line: string) => void): WeatherService {
  const running = new Map<string, Promise<StoredWeather>>();

  async function pick(gameId: string, day: number, phase: Period): Promise<{ weather: Weather; source: WeatherSource }> {
    const ask = `Day ${day}, period ${phase}. Allowed: ${weatherChoices(phase).join(', ')}.`;
    const call = (purpose: 'gm_weather' | 'gm_repair', messages: AiCallRequest['messages']) =>
      ai.call({
        gameId,
        purpose,
        day,
        phase,
        system: [{ id: 'weather_rules', text: RULES_TEXT, cache: true }],
        messages,
        output: { name: 'period_weather', schema: WeatherAnswer },
        maxOutputTokens: 64,
      });

    const first = await call('gm_weather', [{ role: 'user', text: ask }]);
    if (!first.ok) return { weather: FALLBACK_WEATHER, source: 'fallback' };
    const problem = weatherProblem(phase, first.value.weather);
    if (problem === null) return { weather: first.value.weather as Weather, source: 'ai' };

    const repaired = await call('gm_repair', [
      { role: 'user', text: ask },
      { role: 'assistant', text: JSON.stringify(first.value) },
      { role: 'user', text: `Not allowed: ${problem}. Answer again.` },
    ]);
    if (repaired.ok && weatherProblem(phase, repaired.value.weather) === null) return { weather: repaired.value.weather as Weather, source: 'repair' };
    return { weather: FALLBACK_WEATHER, source: 'fallback' };
  }

  async function ensureNow(gameId: string, day: number, phase: Period): Promise<StoredWeather> {
    const stored = weatherAt(db, gameId, { day, phase });
    if (stored) return stored;
    const { weather, source } = await pick(gameId, day, phase);
    const w = weatherOfPeriod(day, weather);
    // A pick that raced another one (another server process) keeps the first stored value.
    db.insert(periodWeather).values({ gameId, day, phase, weather: w.weather, disaster: w.disaster, source, createdAt: now() }).onConflictDoNothing().run();
    const saved = weatherAt(db, gameId, { day, phase })!;
    log(`[weather] game=${gameId} day=${day} phase=${phase} weather=${saved.weather} disaster=${saved.disaster ? 1 : 0} source=${saved.source}`);
    return saved;
  }

  return {
    ensure(gameId, { day, phase }) {
      const stored = weatherAt(db, gameId, { day, phase });
      if (stored) return Promise.resolve(stored);
      const key = `${gameId}:${day}:${phase}`;
      let run = running.get(key);
      if (!run) {
        run = ensureNow(gameId, day, phase).finally(() => running.delete(key));
        running.set(key, run);
      }
      return run;
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
  };
}
