import { PHASE_LABEL, PHASES, type Phase } from '@isekai/protocol';
import type { PeriodWeather, Rng, Turn } from '@isekai/rules';
import type { AiService } from '../ai/core/service.ts';
import type { PromptBlock } from '../ai/provider.ts';
import type { GameAssets } from '../assets/load.ts';
import { serverLine } from '../assets/server-lines.ts';
import { seatedKarmas } from '../crossplayer/phase.ts';
import type { DbOrTx } from '../db/client.ts';
import type { ResolutionEntry } from '../room/resolver.ts';
import { locationSnapshot } from '../visibility/store.ts';
import { weatherAt } from '../weather/service.ts';
import { containsName } from './check.ts';
import { CONTEXT_BUDGET, loadWorld, requestTokens, TOKEN_PATTERN, type GmWorld } from './context.ts';
import { THAI_OUTPUT } from './language.ts';
import { renderTokens } from './loop.ts';
import { lingersNow, lingersOf, npcsPresentAt, type PresenceNow } from './npc-lines.ts';
import { GM_OUTPUT, GmScene } from './schema.ts';

/**
 * GEN-145 (Nok 2026-11-23): when a new period begins, before the results of its first turn, the room gets the server's
 * time announcement (GEN-150 `time_announce`, no AI) and each place with players gets a 2-3 sentence scene from the AI
 * (light, weather, people, the NPCs who arrived / left / stay). The scenes are asked in parallel; a failed one is left out.
 */

type Period = { readonly day: number; readonly phase: Phase };

/** The period before `at` (EOSORIA follows the NOCTHERION of the day before). */
export function previousPeriod(at: Period): Period {
  const i = PHASES.indexOf(at.phase);
  return i > 0 ? { day: at.day, phase: PHASES[i - 1]! } : { day: at.day - 1, phase: 'NOCTHERION' };
}

/** "…ช่วง HESPERION (ค่ำ 18:00-23:59)…"; a new day is named too ("วันที่ 2 · EOSORIA (เช้า 06:00-11:59)"). */
export function periodAnnouncement(assets: GameAssets, at: Period, before: Period, rng?: Rng): string {
  const name = at.day !== before.day ? `วันที่ ${at.day} · ${PHASE_LABEL[at.phase]}` : PHASE_LABEL[at.phase];
  return serverLine(assets.serverLines, 'time_announce', { phase: name }, rng);
}

export interface SceneNpc {
  id: string;
  /** Never the real name (Q-045). */
  alias: string;
}

/**
 * The NPCs of `placeId` the scene tells about: `arrived` (here now, not before), `left` (here before, not now) and
 * `lingering` (here past the schedule after a talk, GEN-144). `before.lingering` = what the last turn left (the NPCs
 * talked to there, or lingering there), `now.lingering` = who lingers in the new period (`lingersNow`).
 */
export function sceneNpcs(world: GmWorld, assets: GameAssets, placeId: string, before: PresenceNow, now: PresenceNow): { arrived: SceneNpc[]; left: SceneNpc[]; lingering: SceneNpc[] } {
  const ids = (p: PresenceNow) => new Set(npcsPresentAt(world, assets, placeId, p).map((n) => n.id));
  const was = ids(before);
  const is = ids(now);
  const stays = new Set((now.lingering ?? []).filter((l) => l.placeId === placeId).map((l) => l.npcId));
  const pick = (keep: (id: string) => boolean) => world.npcs.filter((n) => keep(n.id)).map((n) => ({ id: n.id, alias: n.alias }));
  return {
    arrived: pick((id) => is.has(id) && !was.has(id)),
    left: pick((id) => was.has(id) && !is.has(id)),
    lingering: pick((id) => is.has(id) && stays.has(id)),
  };
}

export interface SceneContext {
  kind: 'gm_scene';
  turn: { day: number; phase: Phase; turn: Turn };
  newDay: boolean;
  weather: string | null;
  place: { id: string; name: string; tags: string[] };
  npcs: ReturnType<typeof sceneNpcs>;
}

const SCENE_TEXT = [
  'You describe the scene for the Game Master. A new period (turn) has just begun; every player at the place reads this scene together before the turn\'s results',
  'Describe the place in 2-3 sentences: the light of this period, the weather, ordinary people, and the NPCs in npcs: arrived = just came / left = just went away / lingering = still here because a talk with a player is unfinished',
  'Call NPCs only by {{n:id}}, never a real name; never mention the players; never invent events that are not in the context. Answer JSON {"text": "..."}',
  THAI_OUTPUT,
].join('\n');
export const SCENE_BLOCK: PromptBlock = { id: 'scene-rules', text: SCENE_TEXT, cache: true };

export interface SceneDeps {
  db: DbOrTx;
  ai: Pick<AiService, 'call'>;
  assets: GameAssets;
  log: (line: string) => void;
}

/** The scene of every place with players at `at` (turn 1 of a new period), as feed entries; a place whose call fails has none. */
export async function periodScenes(
  deps: SceneDeps,
  input: { readonly gameId: string; readonly at: { day: number; phase: Phase; turn: Turn }; readonly weather: PeriodWeather | null; readonly signal?: AbortSignal },
): Promise<ResolutionEntry[]> {
  const { db, ai, assets, log } = deps;
  const { gameId, at, signal } = input;
  const world = loadWorld(db, gameId, assets);
  const prev = previousPeriod(at);
  const karmas = seatedKarmas(db, gameId);
  const before: PresenceNow = { phase: prev.phase, weather: weatherAt(db, gameId, prev)?.weather ?? null, karmas, lingering: lingersOf(db, gameId) };
  const base = { phase: at.phase, weather: input.weather?.weather ?? null, karmas };
  const now: PresenceNow = { ...base, lingering: lingersNow(db, world, assets, base).lingering };
  // Where everyone is now: a player who moved in the last turn reads the scene of the new place.
  const readers = new Map<string, string[]>();
  for (const [memberId, placeId] of locationSnapshot(db, gameId)) {
    if (world.players.has(memberId) && world.places.some((p) => p.id === placeId)) readers.set(placeId, [...(readers.get(placeId) ?? []), memberId]);
  }
  const realNames = [...[...world.players.values()].map((p) => p.name), ...world.npcs.flatMap((n) => n.names.filter((name) => name !== n.alias))].filter((n) => n.trim().length > 0);

  const scenes = await Promise.all(
    [...readers].map(async ([placeId, members]): Promise<ResolutionEntry[]> => {
      const place = world.places.find((p) => p.id === placeId)!;
      const ctx: SceneContext = {
        kind: 'gm_scene',
        turn: at,
        newDay: at.day !== prev.day,
        weather: input.weather ? `${input.weather.weather}${input.weather.disaster ? ' + Disaster' : ''}` : null,
        place: { id: place.id, name: place.name, tags: place.tags },
        npcs: sceneNpcs(world, assets, placeId, before, now),
      };
      const messages = [{ role: 'user' as const, text: JSON.stringify(ctx) }];
      const audience = `scene:${placeId}`;
      if (requestTokens([SCENE_BLOCK], messages) > CONTEXT_BUDGET.narrate_place) {
        log(`[gm] game=${gameId} purpose=narrate_place audience=${audience} skipped: limit_exceeded`);
        return [];
      }
      const result = await ai.call({
        gameId,
        purpose: 'narrate_place',
        day: at.day,
        phase: at.phase,
        turn: at.turn,
        system: [SCENE_BLOCK],
        messages,
        output: { name: GM_OUTPUT.scene, schema: GmScene },
        maxOutputTokens: 600,
        maxRetries: 1,
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) {
        log(`[gm] game=${gameId} purpose=narrate_place audience=${audience} gave up: ${result.error.code}${result.error.detail ? ` (${result.error.detail.split(':')[0]})` : ''}`);
        return [];
      }
      const text = result.value.text;
      // No repair: a scene with a player, an unknown NPC or a real name is left out (the announcement stays).
      const tokensOk = [...text.matchAll(TOKEN_PATTERN)].every(([, kind, id]) => kind === 'n' && world.npcs.some((n) => n.id === id));
      if (!tokensOk || realNames.some((name) => containsName(text, name))) {
        log(`[gm] game=${gameId} purpose=narrate_place audience=${audience} refused: bad tokens or a real name`);
        return [];
      }
      // GEN-121: one scene for the place; a reader who knows an NPC's real name gets it in their own copy.
      const shared = renderTokens(db, world, text, null, true);
      const own = new Map<string, string[]>();
      for (const m of members) {
        const t = renderTokens(db, world, text, m, true);
        if (t !== shared) own.set(t, [...(own.get(t) ?? []), m]);
      }
      const feed = { kind: 'feed' as const, locationId: placeId, actorMemberId: null };
      return [{ ...feed, text: shared, except: [...own.values()].flat() }, ...[...own].map(([t, only]): ResolutionEntry => ({ ...feed, text: t, only }))];
    }),
  );
  return scenes.flat();
}
