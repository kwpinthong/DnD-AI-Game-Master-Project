/**
 * Places and travel (GEN-066) from the sheet: the Location tab (14 places in 4 zones + the Astral Rift) and
 * System_Rules "กฎการเดินทาง & Stamina". Pure functions of the game data and the facts the caller gives;
 * the database side is service.ts.
 *
 * A place's id is its Location `name` (the sheet has no id column; `GameAssets.location(name)` already
 * looks places up by it).
 */
import type { Degree, Period } from '@isekai/rules';
import type { GameAssets } from '../assets/load.ts';
import type { NpcScheduleRecord, Weather } from '../assets/model.ts';

export interface Place {
  /** = the Location name. */
  readonly id: string;
  readonly name: string;
  /** The zone without its English part: "โซนใจกลางเมือง". */
  readonly zone: string;
  readonly tags: readonly string[];
}

/** Location tags that carry a travel rule. */
export const PLACE_TAG = {
  restricted: 'RESTRICTED_AREA',
  hazard: 'HAZARD_DAY5',
  rift: 'ASTRAL',
  riftGate: 'LIBRARY',
  blackMarket: 'BACK_ALLEY',
  /** The "กฎทั้ง 5 สภาพอากาศ" row: rules text, not a place. */
  notAPlace: 'GLOBAL_WEATHER_RULES',
} as const;

/** System_Rules "กฎการเดินทาง & Stamina" and the Location rows' special mechanics. */
export const TRAVEL = {
  sameZoneStamina: 1,
  crossZoneStamina: 3,
  /** Into the Astral Rift from the library: no turn, like a move within a zone (the sheet gives no cost). */
  riftStamina: 1,
  hazardStamina: 10,
  hazardFromDay: 5,
  seaClosedFromDay: 5,
  /** Karma "เป็นกลาง" (-13..+13): who may open the rift. */
  neutralKarma: { min: -13, max: 13 },
} as const;

/** "ค่ำ" / "คืน": the black market and the rift's night. */
export const NIGHT_PERIODS: readonly Period[] = ['HESPERION', 'NOCTHERION'];

export interface PlaceMap {
  readonly places: readonly Place[];
  place(id: string): Place | undefined;
}

/** "โซนใจกลางเมือง (Central Zone)" → "โซนใจกลางเมือง" (Start_Scenarios writes zones without the English part). */
const zoneKey = (zone: string) => zone.split(' (')[0]!.trim();

export function placeMap(assets: Pick<GameAssets, 'locations'>): PlaceMap {
  const places: Place[] = assets.locations
    .filter((l) => !l.tags.includes(PLACE_TAG.notAPlace))
    .map((l) => ({ id: l.name, name: l.name, zone: zoneKey(l.zone), tags: l.tags }));
  const byId = new Map(places.map((p) => [p.id, p]));
  return { places, place: (id) => byId.get(id) };
}

const refuse = (code: MoveRefusal): MovePlan => ({ ok: false, code, message: MOVE_REFUSAL_MESSAGE[code] });
const isNight = (phase: Period) => NIGHT_PERIODS.includes(phase);

export interface MoveContext {
  readonly day: number;
  readonly phase: Period;
  readonly stamina: number;
  readonly karma: number;
  /** The weather now (GEN-068 decides it later); null = none known. */
  readonly weather: Weather | null;
  /** The Location of the player's Start_Scenarios row (GEN-065): the restricted place they may enter. null = none. */
  readonly spawnPlace: string | null;
  /** Knows the black market's password (modelled as a flag until the game has one). */
  readonly blackMarketPassword: boolean;
  /** The degree of an INFILTRATE roll from the resolution engine; absent = walking in. */
  readonly infiltration?: Degree;
}

export type MoveKind = 'same_zone' | 'cross_zone' | 'rift';

export type MoveRefusal =
  | 'unknown_location'
  | 'already_here'
  | 'not_enough_stamina'
  | 'restricted'
  | 'infiltrate_failed'
  | 'black_market_closed'
  | 'rift_closed'
  | 'rift_gateway';

export const MOVE_REFUSAL_MESSAGE: Readonly<Record<MoveRefusal, string>> = {
  unknown_location: 'ไม่มีสถานที่นี้ในเมือง',
  already_here: 'คุณอยู่ที่นี่แล้ว',
  not_enough_stamina: 'แรงไม่พอ',
  restricted: 'เขตหวงห้าม เข้าตรง ๆ ไม่ได้ ต้องมีสิทธิ์ หรือลอบเข้า (INFILTRATE)',
  infiltrate_failed: 'ลอบเข้าไม่สำเร็จ ยังอยู่ที่เดิม',
  black_market_closed: 'ตลาดมืดช่วงค่ำเข้าได้เฉพาะผู้รู้รหัสผ่าน หรือผู้ที่กรรมติดลบ',
  rift_closed: 'ประตูมิติพิศวงไม่เปิด (เปิดเฉพาะคืนฟ้าโปร่ง และกรรมต้องเป็นกลาง)',
  rift_gateway: 'เข้ามิติพิศวงได้ทางหอสมุดหลวงเท่านั้น',
};

export type MovePlan =
  | { readonly ok: true; readonly kind: MoveKind; readonly to: Place; readonly staminaCost: number; readonly spendsTurn: boolean }
  | { readonly ok: false; readonly code: MoveRefusal; readonly message: string };

/** Whether `from` (null = a place the data does not know) may go to `toId` now, and what it costs. */
export function planMove(map: PlaceMap, from: Place | null, toId: string, ctx: MoveContext): MovePlan {
  const to = map.place(toId);
  if (!to) return refuse('unknown_location');
  if (from?.id === to.id) return refuse('already_here');

  if (to.tags.includes(PLACE_TAG.rift)) {
    if (!from?.tags.includes(PLACE_TAG.riftGate)) return refuse('rift_gateway');
    const neutral = ctx.karma >= TRAVEL.neutralKarma.min && ctx.karma <= TRAVEL.neutralKarma.max;
    if (ctx.weather !== 'Clear Night' || !isNight(ctx.phase) || !neutral) return refuse('rift_closed');
    return affordable({ ok: true, kind: 'rift', to, staminaCost: TRAVEL.riftStamina, spendsTurn: false }, ctx);
  }
  if (to.tags.includes(PLACE_TAG.restricted) && ctx.spawnPlace !== to.name) {
    if (ctx.infiltration === undefined) return refuse('restricted');
    if (ctx.infiltration !== 'success' && ctx.infiltration !== 'crit') return refuse('infiltrate_failed');
  }
  if (to.tags.includes(PLACE_TAG.blackMarket) && isNight(ctx.phase) && ctx.karma >= 0 && !ctx.blackMarketPassword) {
    return refuse('black_market_closed');
  }
  const sameZone = from !== null && from.zone === to.zone;
  return affordable(
    sameZone
      ? { ok: true, kind: 'same_zone', to, staminaCost: TRAVEL.sameZoneStamina, spendsTurn: false }
      : { ok: true, kind: 'cross_zone', to, staminaCost: TRAVEL.crossZoneStamina, spendsTurn: true },
    ctx,
  );
}

function affordable(plan: Extract<MovePlan, { ok: true }>, ctx: MoveContext): MovePlan {
  return ctx.stamina < plan.staminaCost ? refuse('not_enough_stamina') : plan;
}

/** Stamina a turn spent at `place` costs on game day `day` (HAZARD_DAY5 from day 5). */
export function hazardStaminaLoss(place: Place | null, day: number): number {
  return place?.tags.includes(PLACE_TAG.hazard) && day >= TRAVEL.hazardFromDay ? TRAVEL.hazardStamina : 0;
}

/** "ออกนอกเมืองทางเรือ": closed from day 5 (Location ทะเล). Modelled as a yes / no until the game has the exit. */
export function leaveTownBySea(day: number): { readonly ok: true } | { readonly ok: false; readonly code: 'sea_closed'; readonly message: string } {
  if (day >= TRAVEL.seaClosedFromDay) {
    return { ok: false, code: 'sea_closed', message: 'คลื่นยักษ์และพายุปิดทะเลแล้ว ออกนอกเมืองทางเรือไม่ได้' };
  }
  return { ok: true };
}

const CONDITION = /^karma\s*(<=|>=|<|>)\s*([+-]?\d+)$/;

/** "karma < -50" and the like; a condition the server cannot read keeps the NPC away (the AI GM may still place them). */
function conditionHolds(condition: string, karma: number): boolean {
  const text = condition.trim();
  if (text === '') return true;
  const m = CONDITION.exec(text);
  if (!m) return false;
  const n = Number(m[2]);
  switch (m[1]) {
    case '<':
      return karma < n;
    case '<=':
      return karma <= n;
    case '>':
      return karma > n;
    default:
      return karma >= n;
  }
}

/** NPCs the NPC_Schedule tab puts at `placeName` now (Q-092); empty period / weather lists mean any. */
export function npcsAt(
  schedule: readonly NpcScheduleRecord[],
  placeName: string,
  now: { readonly phase: Period; readonly weather: Weather | null; readonly karma: number },
): string[] {
  const here = schedule.filter(
    (r) =>
      r.location === placeName &&
      (r.periods.length === 0 || r.periods.includes(now.phase)) &&
      (r.weathers.length === 0 || (now.weather !== null && r.weathers.includes(now.weather))) &&
      conditionHolds(r.condition, now.karma),
  );
  return [...new Set(here.map((r) => r.npc))];
}
