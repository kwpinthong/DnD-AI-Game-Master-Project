import { ANY_TAG, type PhaseLogEntry, type PhaseState, type PlayerResult, type RestSite } from '@isekai/rules';
import { eq, sql } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { StartScenarioRecord } from '../assets/model.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, characterOrigin } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { locationSnapshot, presenceOf } from '../visibility/store.ts';

/**
 * GEN-069: the Location tab's Special_Mechanics the server runs, keyed by the place's Location tags (a
 * scenario place counts as the Location row of its name), plus the start scenario passives that are not d20
 * bonuses (Q-209). Numbers of the rest itself live in the phase engine (@isekai/rules `REST`, `TRAIN`).
 * - Inn (TAVERN): REST costs 5 coins (refused under 5); the engine gives +10 by day, Rest_Quality by night.
 * - Infirmary (CLINIC): REST HP +15, both turns of one period = full HP.
 * - Guild (QUEST_HUB): TRAIN raises Max HP (once a day, up to 45).
 * - Fountain (PUBLIC): a Public action moves Reputation ×1.5.
 * Trade, bags and auctions are later work.
 */
export const LOCATION_TAG = { inn: 'TAVERN', clinic: 'CLINIC', guild: 'QUEST_HUB', publicSquare: 'PUBLIC' } as const;
export const INN_REST_COINS = 5;
export const PUBLIC_REP_SCALE = 1.5;

type Scenario = ReturnType<typeof getGameScenario>;

/** The Location tags of a place: its scenario place's Location row by name, or the Location named by the id. */
export function placeTags(scenario: Scenario, assets: GameAssets, locationId: string): readonly string[] {
  const name = scenario?.locations.find((l) => l.id === locationId)?.name;
  return (name !== undefined ? assets.location(name)?.tags : undefined) ?? assets.location(locationId)?.tags ?? [];
}

function restSiteOf(tags: readonly string[]): RestSite | null {
  if (tags.includes(LOCATION_TAG.inn)) return 'inn';
  if (tags.includes(LOCATION_TAG.clinic)) return 'clinic';
  return null;
}

/** Scenario places where a Public action moves Reputation ×1.5 (`CrossPlayerState.publicRepScale`). */
export function publicRepScaleOf(db: DbOrTx, gameId: string, assets: GameAssets): Record<string, number> {
  const scenario = getGameScenario(db, gameId);
  const out: Record<string, number> = {};
  for (const l of scenario?.locations ?? []) {
    if (placeTags(scenario, assets, l.id).includes(LOCATION_TAG.publicSquare)) out[l.id] = PUBLIC_REP_SCALE;
  }
  return out;
}

// --- Submit checks ---

export type SubmitRefusal = { readonly code: 'not_enough_coins' | 'train_not_here'; readonly message: string };

export const NOT_ENOUGH_COINS_MESSAGE = `เงินไม่พอ พักที่โรงเตี๊ยมต้องจ่าย ${INN_REST_COINS} เหรียญ`;
export const TRAIN_NOT_HERE_MESSAGE = 'ฝึกฝน (TRAIN) ได้ที่กิลด์เท่านั้น';
export const TRAIN_USED_MESSAGE = 'วันนี้ฝึกที่กิลด์ไปแล้ว ฝึกได้วันละ 1 ครั้ง';
export const TRAIN_CAP_MESSAGE = 'Max HP ถึงเพดาน 45 แล้ว ฝึกเพิ่มไม่ได้อีก';

/** Why `memberId` may not send this REST / TRAIN where they stand; null = they may. */
export function locationActionRefusal(db: DbOrTx, assets: GameAssets, gameId: string, memberId: string, action: { rest: boolean; train: boolean }): SubmitRefusal | null {
  if (!action.rest && !action.train) return null;
  const locationId = presenceOf(db, memberId)?.locationId;
  const tags = locationId === undefined ? [] : placeTags(getGameScenario(db, gameId), assets, locationId);
  if (action.train && !tags.includes(LOCATION_TAG.guild)) return { code: 'train_not_here', message: TRAIN_NOT_HERE_MESSAGE };
  if (action.rest && restSiteOf(tags) === 'inn' && coinsOf(db, memberId) < INN_REST_COINS) return { code: 'not_enough_coins', message: NOT_ENOUGH_COINS_MESSAGE };
  return null;
}

function coinsOf(db: DbOrTx, memberId: string): number {
  return db.select({ coins: character.coins }).from(character).where(eq(character.memberId, memberId)).get()?.coins ?? 0;
}

// --- Start passives that are not d20 bonuses (Q-209) ---

function startRecord(db: DbOrTx, assets: GameAssets, memberId: string): StartScenarioRecord | undefined {
  const name = db.select({ name: characterOrigin.startScenario }).from(characterOrigin).where(eq(characterOrigin.memberId, memberId)).get()?.name;
  return name ? assets.startScenarios.find((s) => s.name === name) : undefined;
}

/** Passive_Condition: "location tag X" where the player is, "วันที่ a-b" on the day (unknown day = holds), empty = always. */
function conditionHolds(condition: string, tags: readonly string[], day: number | null): boolean {
  const text = condition.trim();
  if (text === '') return true;
  const tag = /^location tag ([A-Z0-9_]+)$/.exec(text)?.[1];
  if (tag) return tags.includes(tag);
  const days = /^วันที่\s*(\d+)\s*-\s*(\d+)$/.exec(text);
  if (days) return day === null || (day >= Number(days[1]) && day <= Number(days[2]));
  return false;
}

/** A REST passive (Passive_Verb_Tags REST, Passive_Stat Stamina / HP) that holds where the player rests. */
function restBonusOf(record: StartScenarioRecord | undefined, tags: readonly string[], day: number): PlayerResult['restBonus'] | null {
  if (!record) return null;
  const { verbTags, stat, value, condition } = record.passive;
  if (!verbTags.includes('REST') || value === null || value <= 0 || !conditionHolds(condition, tags, day)) return null;
  if (stat === 'Stamina') return { stamina: value };
  if (stat === 'HP') return { hp: value };
  return null;
}

/** Stamina an action costs the player less where they stand (a stamina_cost passive for every verb, e.g. -1 OUTDOOR). */
export function startStaminaCut(db: DbOrTx, assets: GameAssets, memberId: string, locationId: string, gameId: string): number {
  const record = startRecord(db, assets, memberId);
  if (!record) return 0;
  const { verbTags, stat, value, condition } = record.passive;
  if (stat !== 'stamina_cost' || value === null || value >= 0 || !verbTags.includes(ANY_TAG)) return 0;
  return conditionHolds(condition, placeTags(getGameScenario(db, gameId), assets, locationId), null) ? -value : 0;
}

// --- At the turn's close ---

/**
 * The results with where each player rests: the place's Rest_Quality (Q-218), its Special_Mechanics site
 * (the inn only when the player has the coins; the coins go in `chargeInnRests` once the engine recovered
 * them) and the start passives that add to a REST (Q-209).
 */
export function withLocationRest(
  db: DbOrTx,
  assets: GameAssets,
  gameId: string,
  state: PhaseState,
  results: Readonly<Record<string, PlayerResult>>,
): Record<string, PlayerResult> {
  const scenario = getGameScenario(db, gameId);
  const out: Record<string, PlayerResult> = { ...results };
  for (const [memberId, locationId] of locationSnapshot(db, gameId)) {
    const player = state.players[memberId];
    if (!player) continue;
    const quality = scenario?.locations.find((l) => l.id === locationId)?.restQuality;
    let r: PlayerResult = { ...out[memberId], ...(quality ? { restQuality: quality } : {}) };
    if (player.condition === 'awake' && state.submissions[memberId]?.rest) {
      const tags = placeTags(scenario, assets, locationId);
      const site = restSiteOf(tags);
      if (site === 'clinic' || (site === 'inn' && coinsOf(db, memberId) >= INN_REST_COINS)) r = { ...r, restSite: site };
      const bonus = restBonusOf(startRecord(db, assets, memberId), tags, state.day);
      if (bonus) r = { ...r, restBonus: bonus };
    }
    out[memberId] = r;
  }
  return out;
}

/**
 * What the engine's log of the turn writes to the character (before `syncCharacterStats`, which caps HP at the
 * character's Max HP): the inn's 5 coins of every paid REST it recovered, the Max HP of every TRAIN.
 */
export function applyLocationLog(db: DbOrTx, log: readonly PhaseLogEntry[], now: number): void {
  for (const e of log) {
    if (e.type === 'recovered' && e.site === 'inn') {
      db.update(character)
        .set({ coins: sql`max(0, ${character.coins} - ${INN_REST_COINS})`, updatedAt: now })
        .where(eq(character.memberId, e.playerId))
        .run();
    } else if (e.type === 'trained') {
      db.update(character).set({ hpMax: e.hpMax.after, updatedAt: now }).where(eq(character.memberId, e.playerId)).run();
    }
  }
}
