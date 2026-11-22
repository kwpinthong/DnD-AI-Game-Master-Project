import type { CrossPlayerState, PhaseActionsLog, TagContext, TagSource } from '@isekai/rules';
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { tagSourceUse } from '../db/schema.ts';
import type { GameAssets } from '../assets/load.ts';
import { abilitySource, itemSource, locationSources, tagVocabulary } from '../assets/tags.ts';
import { getGameScenario } from '../scenario/store.ts';
import { itemsInGame, skillsInGame } from './items.ts';

/**
 * Tag matching on the server (GEN-064): builds each player's `TagContext` from what they hold and
 * where they are, and counts Active uses per game day.
 * - Skills / items: every owned skill and held item (GEN-055 `skillsInGame` / `itemsInGame`: loot, NPC
 *   rewards, unlocked skills) whose name is an Ability / Item row of the game data (GEN-062). Loot that is
 *   not in the data has no tags and stays a judged modifier.
 * - Location: the scenario place whose name is a Location row gives its tags and its
 *   Weather_Verb_Boost under the current weather.
 * - Weather (GEN-068) and start passives (GEN-065) come in through `TaggingOptions`.
 * Source order (and so log order): skills, items, location, weather, start passives.
 */
export interface TaggingOptions {
  readonly assets: GameAssets;
  /** The game day the phase is on: Daily_Limit counts per day. */
  readonly day: number;
  /** The current weather (GEN-068 chooses it); null / absent = no Weather_Verb_Boost. */
  readonly weather?: string | null;
  /** Start passives by member id (GEN-065), e.g. from `startPassiveSource`. */
  readonly startPassives?: Readonly<Record<string, readonly TagSource[]>>;
  /** Weather rule sources by member id (GEN-068), kind `weather`. */
  readonly weatherSources?: Readonly<Record<string, readonly TagSource[]>>;
}

/** Activations per source of a member on `day`. */
export function usesOnDay(db: DbOrTx, memberId: string, day: number): Record<string, number> {
  const rows = db.select().from(tagSourceUse).where(and(eq(tagSourceUse.memberId, memberId), eq(tagSourceUse.day, day))).all();
  return Object.fromEntries(rows.map((r) => [r.sourceId, r.uses]));
}

/** Each seated player's tag context for this phase. */
export function tagContexts(db: DbOrTx, gameId: string, state: CrossPlayerState, options: TaggingOptions): Record<string, TagContext> {
  const { assets } = options;
  const vocabulary = tagVocabulary(assets);
  const skills = skillsInGame(db, gameId);
  const items = [...itemsInGame(db, gameId).values()];
  const places = new Map((getGameScenario(db, gameId)?.locations ?? []).map((l) => [l.id, assets.location(l.name)]));

  const contexts: Record<string, TagContext> = {};
  for (const player of Object.values(state.players)) {
    const place = places.get(player.locationId);
    const sources: TagSource[] = [
      ...(skills.get(player.id) ?? []).flatMap((s) => {
        const ability = assets.ability(s.name);
        return ability ? [abilitySource(s.id, ability)] : [];
      }),
      ...items.filter((i) => i.holderMemberId === player.id).flatMap((i) => {
        const record = assets.item(i.name);
        return record ? [itemSource(i.id, record)] : [];
      }),
      ...(place ? locationSources(place, options.weather ?? null) : []),
      ...(options.weatherSources?.[player.id] ?? []),
      ...(options.startPassives?.[player.id] ?? []),
    ];
    contexts[player.id] = { vocabulary, sources, usesToday: usesOnDay(db, player.id, options.day), locationTags: place?.tags ?? [] };
  }
  return contexts;
}

/** Adds the phase's activations to the day's counts (call inside the phase transaction). */
export function recordTagUses(db: DbOrTx, gameId: string, log: PhaseActionsLog, day: number, now: number): void {
  for (const outcome of log.outcomes) {
    if (outcome.status !== 'resolved') continue;
    for (const { ref } of outcome.log.tagging?.activated ?? []) {
      db.insert(tagSourceUse)
        .values({ gameId, memberId: outcome.actorId, sourceId: ref, day, uses: 1, updatedAt: now })
        .onConflictDoUpdate({
          target: [tagSourceUse.memberId, tagSourceUse.sourceId, tagSourceUse.day],
          set: { uses: sql`${tagSourceUse.uses} + 1`, updatedAt: now },
        })
        .run();
    }
  }
}
