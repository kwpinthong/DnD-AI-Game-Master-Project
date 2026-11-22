/**
 * Tag sources from the game data (GEN-064 on top of GEN-062): what the resolution engine's tag
 * matching (@isekai/rules `TagSource`) reads from the Ability / Item / Location / Start_Scenarios
 * rows. Numbers come only from the structured columns (Q-090): a positive `dice_bonus` effect is the
 * d20 bonus; everything else is qualitative and stays text for the AI. A negative `dice_bonus`
 * (Venom of Despair) is put on someone else, so it is no bonus of the actor.
 */
import { ANY_TAG, type TagSource } from '@isekai/rules';
import type { GameAssets } from './load.ts';
import { DICE_BONUS_EXCEPTIONS, type AbilityRecord, type Effect, type ItemRecord, type LocationRecord, type StartScenarioRecord, type TriggerType } from './model.ts';

/** Weather_Verb_Boost: a boosted verb under the place's weather gets +2 (Q-089). */
export const WEATHER_VERB_BOOST = 2;

const TRIGGER: Readonly<Record<TriggerType, TagSource['trigger']>> = { Active: 'active', Passive: 'passive', 'Passive + Active': 'both' };

const diceBonusOf = (effects: readonly Effect[]) => effects.filter((e) => e.type === 'dice_bonus' && e.value > 0).reduce((sum, e) => sum + e.value, 0);

/** Every tag the data uses (the only tags a proposal may name), sorted, without ANY. */
export function tagVocabulary(assets: GameAssets): string[] {
  const tags = new Set<string>();
  const add = (list: readonly string[]) => list.forEach((t) => tags.add(t));
  for (const r of [...assets.abilities, ...assets.items, ...assets.npcs, ...(assets.day10Strategies ?? [])]) {
    add(r.matchVerbTags);
    add(r.matchTargetTags);
  }
  for (const l of assets.locations) {
    add(l.tags);
    for (const boost of parseWeatherVerbBoost(l.weatherVerbBoost)) add(boost.verbs);
  }
  for (const s of assets.startScenarios) {
    add(s.tags);
    add(s.passive.verbTags);
  }
  tags.delete(ANY_TAG);
  return [...tags].sort();
}

function recordSource(id: string, kind: 'skill' | 'item', r: AbilityRecord | ItemRecord, name: string): TagSource {
  return {
    id,
    kind,
    rank: r.rank,
    trigger: TRIGGER[r.triggerType],
    dailyLimit: r.dailyLimit,
    verbTags: r.matchVerbTags,
    targetTags: r.matchTargetTags,
    requireLocationTags: [],
    diceBonus: diceBonusOf(r.effects),
    diceBonusCap: DICE_BONUS_EXCEPTIONS[name] ?? null,
  };
}

/** An owned skill (loot option `id`) backed by an Ability row. */
export function abilitySource(id: string, ability: AbilityRecord): TagSource {
  return recordSource(id, 'skill', ability, ability.name);
}

/** An owned item (loot option `id`) backed by an Item row. */
export function itemSource(id: string, item: ItemRecord): TagSource {
  return recordSource(id, 'item', item, item.nameEn);
}

/** The start passive of a Start_Scenarios row (GEN-065 gives it to the player); null when it has no d20 bonus. */
export function startPassiveSource(scenario: StartScenarioRecord): TagSource | null {
  const { verbTags, stat, value, condition } = scenario.passive;
  if (stat !== 'd20' || value === null || value <= 0 || verbTags.length === 0) return null;
  const locationTag = /^location tag ([A-Z0-9_]+)$/.exec(condition.trim())?.[1];
  return {
    id: `start:${scenario.name}`,
    kind: 'start_passive',
    rank: null,
    trigger: 'passive',
    dailyLimit: 0,
    verbTags,
    targetTags: [],
    requireLocationTags: locationTag ? [locationTag] : [],
    diceBonus: value,
    diceBonusCap: null,
  };
}

/** "Clear: [PERSUADE, SHARE] / Rain/Storm: [OBSERVE]" → the conditions and the verbs each boosts. */
export function parseWeatherVerbBoost(text: string): { conditions: string[]; verbs: string[] }[] {
  const out: { conditions: string[]; verbs: string[] }[] = [];
  for (const m of text.matchAll(/([^:[\]]+?):\s*\[([^\]]*)\]/g)) {
    const conditions = m[1]!.replace(/^[\s/]+/, '').split('/').map((c) => c.trim()).filter(Boolean);
    const verbs = m[2]!.split(',').map((v) => v.trim()).filter(Boolean);
    if (conditions.length > 0 && verbs.length > 0) out.push({ conditions, verbs });
  }
  return out;
}

/**
 * "Night" in the sheet means any night weather (Clear Night, Dark Night); "Clear" also means Clear Morning
 * and Clear Night (Q-132); other names must be equal.
 */
const weatherFits = (condition: string, weather: string) =>
  condition === weather || (condition === 'Night' && weather.endsWith(' Night')) || (condition === 'Clear' && weather.startsWith('Clear '));

/**
 * The place's Weather_Verb_Boost under `weather` as one `location` source; none without a weather. `weather`
 * may list every condition the period meets (GEN-068 `boostConditions`: e.g. "Clear Morning" and "Disaster").
 */
export function locationSources(location: LocationRecord, weather: string | readonly string[] | null): TagSource[] {
  if (weather === null) return [];
  const met = typeof weather === 'string' ? [weather] : weather;
  const verbs = [
    ...new Set(parseWeatherVerbBoost(location.weatherVerbBoost).filter((b) => b.conditions.some((c) => met.some((w) => weatherFits(c, w)))).flatMap((b) => b.verbs)),
  ];
  if (verbs.length === 0) return [];
  return [
    {
      id: `location:${location.name}:${met.join('+')}`,
      kind: 'location',
      rank: null,
      trigger: 'passive',
      dailyLimit: 0,
      verbTags: verbs,
      targetTags: [],
      requireLocationTags: [],
      diceBonus: WEATHER_VERB_BOOST,
      diceBonusCap: null,
    },
  ];
}
