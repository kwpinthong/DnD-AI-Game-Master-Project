/**
 * Weather per period (GEN-068, Q-089). When a period opens the AI GM picks one weather from the choices
 * the server allows; the server checks it (repair once, then Clear) and applies the rules itself.
 * The sheet's "กฎทั้ง 5 สภาพอากาศ" row (Location tab, GLOBAL_WEATHER_RULES) wins over the GDD:
 * - แดดจ้า (Clear): a Secret action rolls d20 -2.
 * - ฝนตก (Rain) and พายุ (Storm, Q-156): an outdoor action costs +1 Stamina; a stealth action rolls d20 +2.
 * - หมอกจัด (Fog): grade S NPCs are easier to find; คืนเดือนมืด (Dark Night): secret passages open and the
 *   Evil side is stronger. Both are qualitative: text for the AI, no number here.
 * - ภัยพิบัติ (Disaster, day 5 on, every period whatever the AI picked): the exits out of town are closed and
 *   an outdoor action costs +2 Stamina.
 * EOSORIA / SOLARION have no night weather. Every value is plain JSON so a log replays.
 */
import type { Period } from './phase/types.ts';
import type { ActionTag, Visibility } from './resolution/types.ts';

/** The one list of live weathers: `@isekai/protocol` re-exports it (GEN-191). */
export const WEATHERS = ['Clear', 'Rain', 'Fog', 'Dark Night', 'Clear Night', 'Storm'] as const;
export type Weather = (typeof WEATHERS)[number];

export const NIGHT_WEATHERS: readonly Weather[] = ['Dark Night', 'Clear Night'];
/** The periods without night weather. */
export const DAY_PERIODS: readonly Period[] = ['EOSORIA', 'SOLARION'];
/** Disaster holds from this game day on. */
export const DISASTER_FROM_DAY = 5;
/** What the period gets when the AI's choice is still wrong after one repair, or the AI fails. */
export const FALLBACK_WEATHER: Weather = 'Clear';
/** The location tag that makes an action outdoor (กลางแจ้ง). */
export const OUTDOOR_TAG = 'OUTDOOR';
export const STEALTH_VERB = 'STEALTH';

export const WEATHER_RULES = {
  clearSecretD20: -2,
  rainOutdoorStamina: 1,
  rainStealthD20: 2,
  disasterOutdoorStamina: 2,
} as const;

/** Weathers with Rain's numbers (Q-156: Storm = Rain: OUTDOOR Stamina +1, STEALTH d20 +2). */
export const RAIN_LIKE: readonly Weather[] = ['Rain', 'Storm'];

/** The weather of one period: what the AI picked (checked), plus Disaster from day 5. */
export interface PeriodWeather {
  readonly weather: Weather;
  readonly disaster: boolean;
}

/** The weather as one action meets it. */
export interface ActionWeather extends PeriodWeather {
  /** The actor's place has the OUTDOOR tag. */
  readonly outdoor: boolean;
}

export interface WeatherLog {
  readonly weather: Weather;
  readonly disaster: boolean;
  readonly outdoor: boolean;
  /** d20 modifiers, also listed in the check with source `weather`; `ref` names the rule, e.g. "Clear:secret". */
  readonly modifiers: readonly { readonly ref: string; readonly value: number }[];
  /** Extra Stamina the action costs, on top of its own cost. */
  readonly stamina: number;
}

/** The weathers the AI may pick for `phase`. */
export function weatherChoices(phase: Period): Weather[] {
  return DAY_PERIODS.includes(phase) ? WEATHERS.filter((w) => !NIGHT_WEATHERS.includes(w)) : [...WEATHERS];
}

export function isDisasterDay(day: number): boolean {
  return day >= DISASTER_FROM_DAY;
}

/** Why `value` is not a weather for `phase` (English, for the AI's repair); null = fine. */
export function weatherProblem(phase: Period, value: unknown): string | null {
  const choices = weatherChoices(phase);
  if (typeof value === 'string' && (choices as readonly string[]).includes(value)) return null;
  const why = typeof value === 'string' && (WEATHERS as readonly string[]).includes(value) ? `${value} is a night weather; ${phase} has none` : `${JSON.stringify(value ?? null)} is not a weather`;
  return `${why}. Pick exactly one of: ${choices.join(', ')}`;
}

/** The period's weather from a checked choice (Disaster from `DISASTER_FROM_DAY`). */
export function periodWeather(day: number, weather: Weather): PeriodWeather {
  return { weather, disaster: isDisasterDay(day) };
}

/**
 * The conditions this weather meets in a place's Weather_Verb_Boost: its name ("Clear" in EOSORIA is
 * "Clear Morning"; the sheet's "Clear" also means Clear Morning / Clear Night, Q-132), plus "Disaster".
 */
export function boostConditions(w: PeriodWeather, phase: Period): string[] {
  const name = w.weather === 'Clear' && phase === 'EOSORIA' ? 'Clear Morning' : w.weather;
  return w.disaster ? [name, 'Disaster'] : [name];
}

/** What the weather does to one action. */
export function weatherEffects(
  w: ActionWeather,
  action: { readonly visibility: Visibility; readonly verbTags: readonly string[]; readonly actionTags: readonly ActionTag[] },
): WeatherLog {
  const modifiers: { ref: string; value: number }[] = [];
  let stamina = 0;
  if (w.weather === 'Clear' && action.visibility === 'secret') modifiers.push({ ref: 'Clear:secret', value: WEATHER_RULES.clearSecretD20 });
  if (RAIN_LIKE.includes(w.weather)) {
    // The ref keeps the weather's own name ("Storm:STEALTH") so the log says which one applied.
    if (action.verbTags.includes(STEALTH_VERB) || action.actionTags.includes('stealth')) modifiers.push({ ref: `${w.weather}:${STEALTH_VERB}`, value: WEATHER_RULES.rainStealthD20 });
    if (w.outdoor) stamina += WEATHER_RULES.rainOutdoorStamina;
  }
  if (w.disaster && w.outdoor) stamina += WEATHER_RULES.disasterOutdoorStamina;
  return { weather: w.weather, disaster: w.disaster, outdoor: w.outdoor, modifiers, stamina };
}
