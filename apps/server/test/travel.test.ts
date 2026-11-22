import { describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import { hazardStaminaLoss, leaveTownBySea, npcsAt, placeMap, planMove, TRAVEL, type MoveContext } from '../src/travel/rules.ts';

/** GEN-066: the travel rules on the real game data (apps/server/assets). */
const assets = loadGameAssets();
const map = placeMap(assets);
const at = (id: string) => {
  const place = map.place(id);
  if (!place) throw new Error(`no place ${id}`);
  return place;
};

const FOUNTAIN = 'น้ำพุกลางเมือง';
const CHURCH = 'โบสถ์';
const FOREST = 'ป่า';
const SEA = 'ทะเล';
const MANOR = 'เคหาสน์เจ้าเมือง';
const BARRACKS = 'ค่ายทหารป้องกันเมือง';
const BLACK_MARKET = 'ย่านการค้า-ตลาดมืด';
const LIBRARY = 'หอสมุดหลวง';
const RIFT = 'มิติพิศวง (The Astral Rift)';

const ctx = (overrides: Partial<MoveContext> = {}): MoveContext => ({
  day: 1,
  phase: 'EOSORIA',
  stamina: 30,
  karma: 0,
  weather: null,
  spawnPlace: null,
  blackMarketPassword: false,
  ...overrides,
});

describe('GEN-066 places and travel rules', () => {
  it('the map has the 15 places in 4 zones plus the Astral Rift, and not the weather rules row', () => {
    const zones = new Map<string, string[]>();
    for (const p of map.places) zones.set(p.zone, [...(zones.get(p.zone) ?? []), p.name]);
    expect(map.places).toHaveLength(16);
    expect([...zones.keys()].sort()).toEqual(['รูทลับ 1%', 'โซนการค้าทิศตะวันตก', 'โซนที่ราบทิศเหนือ', 'โซนป่าทิศตะวันออก', 'โซนใจกลางเมือง'].sort());
    expect(zones.get('รูทลับ 1%')).toEqual([RIFT]);
    expect(map.places.some((p) => p.name === 'กฎทั้ง 5 สภาพอากาศ')).toBe(false);
    expect(at(CHURCH)).toMatchObject({ id: CHURCH, zone: 'โซนใจกลางเมือง' });
  });

  it('C1: fountain -> church (same zone) costs Stamina 1 and not the turn', () => {
    expect(planMove(map, at(FOUNTAIN), CHURCH, ctx())).toEqual({ ok: true, kind: 'same_zone', to: at(CHURCH), staminaCost: 1, spendsTurn: false });
    // Stamina 1 is enough for a move within the zone.
    expect(planMove(map, at(FOUNTAIN), CHURCH, ctx({ stamina: 1 }))).toMatchObject({ ok: true, staminaCost: 1 });
  });

  it('C2: fountain -> forest (another zone) spends the turn and Stamina 3; with Stamina 2 it is refused "แรงไม่พอ"', () => {
    expect(planMove(map, at(FOUNTAIN), FOREST, ctx())).toEqual({ ok: true, kind: 'cross_zone', to: at(FOREST), staminaCost: 3, spendsTurn: true });
    const tired = planMove(map, at(FOUNTAIN), FOREST, ctx({ stamina: 2 }));
    expect(tired).toMatchObject({ ok: false, code: 'not_enough_stamina' });
    expect(tired.ok ? '' : tired.message).toContain('แรงไม่พอ');
    // A place the data does not know: every move counts as another zone.
    expect(planMove(map, null, CHURCH, ctx())).toMatchObject({ ok: true, kind: 'cross_zone', staminaCost: 3 });
  });

  it('C3: from day 5 the forest and the sea cost Stamina 10 a turn and the sea exit is closed; day 4 neither', () => {
    expect(hazardStaminaLoss(at(FOREST), 5)).toBe(TRAVEL.hazardStamina);
    expect(hazardStaminaLoss(at(SEA), 9)).toBe(10);
    expect(hazardStaminaLoss(at(FOREST), 4)).toBe(0);
    expect(hazardStaminaLoss(at(SEA), 4)).toBe(0);
    expect(hazardStaminaLoss(at(FOUNTAIN), 5)).toBe(0);
    expect(hazardStaminaLoss(null, 5)).toBe(0);

    const closed = leaveTownBySea(5);
    expect(closed).toMatchObject({ ok: false, code: 'sea_closed' });
    expect(closed.ok ? '' : closed.message).toMatch(/[ก-๙]/);
    expect(leaveTownBySea(4)).toEqual({ ok: true });
  });

  it('C4: the manor and the barracks are refused without a right; INFILTRATE enters on a success; a soldier walks into the barracks', () => {
    for (const place of [MANOR, BARRACKS, 'โบสถ์ (ชั้นใต้ดิน)']) {
      expect(planMove(map, at(FOUNTAIN), place, ctx()), place).toMatchObject({ ok: false, code: 'restricted' });
    }
    expect(planMove(map, at(FOUNTAIN), MANOR, ctx({ infiltration: 'success' }))).toMatchObject({ ok: true, kind: 'cross_zone' });
    expect(planMove(map, at(FOUNTAIN), MANOR, ctx({ infiltration: 'crit' }))).toMatchObject({ ok: true });
    expect(planMove(map, at(FOUNTAIN), MANOR, ctx({ infiltration: 'fail' }))).toMatchObject({ ok: false, code: 'infiltrate_failed' });
    expect(planMove(map, at(FOUNTAIN), MANOR, ctx({ infiltration: 'fumble' }))).toMatchObject({ ok: false, code: 'infiltrate_failed' });

    const soldier = assets.startScenarios.find((s) => s.name === 'ทหารเกณฑ์ประจำป้อม')!;
    expect(planMove(map, at(BLACK_MARKET), BARRACKS, ctx({ spawnPlace: soldier.location }))).toMatchObject({ ok: true, kind: 'same_zone' });
    // The soldier's right is the barracks only.
    expect(planMove(map, at(FOUNTAIN), MANOR, ctx({ spawnPlace: soldier.location }))).toMatchObject({ ok: false, code: 'restricted' });
    const noble = assets.startScenarios.find((s) => s.name === 'คุณชาย/คุณหนูขี้โรค')!;
    expect(planMove(map, at(FOUNTAIN), MANOR, ctx({ spawnPlace: noble.location }))).toMatchObject({ ok: true });
  });

  it('C5: the black market at HESPERION / NOCTHERION: karma -5 enters; karma +5 without the password is refused', () => {
    for (const phase of ['HESPERION', 'NOCTHERION'] as const) {
      expect(planMove(map, at(FOUNTAIN), BLACK_MARKET, ctx({ phase, karma: -5 })), phase).toMatchObject({ ok: true, kind: 'cross_zone' });
      expect(planMove(map, at(FOUNTAIN), BLACK_MARKET, ctx({ phase, karma: 5 })), phase).toMatchObject({ ok: false, code: 'black_market_closed' });
      expect(planMove(map, at(FOUNTAIN), BLACK_MARKET, ctx({ phase, karma: 5, blackMarketPassword: true })), phase).toMatchObject({ ok: true });
    }
    // By day it is the ordinary trade quarter.
    expect(planMove(map, at(FOUNTAIN), BLACK_MARKET, ctx({ phase: 'SOLARION', karma: 5 }))).toMatchObject({ ok: true });
  });

  it('C6: from the library on a clear night with karma +10 the rift opens; karma +20, rain or another place is refused', () => {
    const night = ctx({ phase: 'HESPERION', weather: 'Clear Night', karma: 10 });
    expect(planMove(map, at(LIBRARY), RIFT, night)).toEqual({ ok: true, kind: 'rift', to: at(RIFT), staminaCost: TRAVEL.riftStamina, spendsTurn: false });
    expect(planMove(map, at(LIBRARY), RIFT, { ...night, karma: -13 })).toMatchObject({ ok: true });
    expect(planMove(map, at(LIBRARY), RIFT, { ...night, karma: 20 })).toMatchObject({ ok: false, code: 'rift_closed' });
    expect(planMove(map, at(LIBRARY), RIFT, { ...night, karma: -14 })).toMatchObject({ ok: false, code: 'rift_closed' });
    expect(planMove(map, at(LIBRARY), RIFT, { ...night, weather: 'Rain' })).toMatchObject({ ok: false, code: 'rift_closed' });
    expect(planMove(map, at(LIBRARY), RIFT, { ...night, weather: null })).toMatchObject({ ok: false, code: 'rift_closed' });
    expect(planMove(map, at(LIBRARY), RIFT, { ...night, phase: 'SOLARION' })).toMatchObject({ ok: false, code: 'rift_closed' });
    expect(planMove(map, at(FOUNTAIN), RIFT, night)).toMatchObject({ ok: false, code: 'rift_gateway' });
  });

  it('C7: an NPC the schedule puts at the fountain in SOLARION is met there then, not in another period', () => {
    const schedule = assets.npcSchedule!;
    expect(npcsAt(schedule, FOUNTAIN, { phase: 'SOLARION', weather: null, karma: 0 })).toEqual(expect.arrayContaining(['ลูเซีย', 'โนอา']));
    expect(npcsAt(schedule, FOUNTAIN, { phase: 'EOSORIA', weather: null, karma: 0 })).not.toContain('ลูเซีย');
    expect(npcsAt(schedule, FOUNTAIN, { phase: 'NOCTHERION', weather: null, karma: 0 })).toEqual([]);
    // A weather row needs that weather; a karma condition needs that karma.
    expect(npcsAt(schedule, FOUNTAIN, { phase: 'EOSORIA', weather: 'Clear', karma: 0 })).toContain('อาร์คบิชอป มัลคอล์ม');
    expect(npcsAt(schedule, FOUNTAIN, { phase: 'EOSORIA', weather: null, karma: 0 })).not.toContain('อาร์คบิชอป มัลคอล์ม');
    expect(npcsAt(schedule, CHURCH, { phase: 'HESPERION', weather: null, karma: -60 })).toContain('น็อกทิส');
    expect(npcsAt(schedule, CHURCH, { phase: 'HESPERION', weather: null, karma: -50 })).not.toContain('น็อกทิส');
    // Empty period list = always there.
    expect(npcsAt(schedule, RIFT, { phase: 'NOCTHERION', weather: null, karma: 0 })).toEqual(['แอสทรา']);
  });

  it('C8: a location id that does not exist is an error', () => {
    const plan = planMove(map, at(FOUNTAIN), 'ลานตลาด', ctx());
    expect(plan).toMatchObject({ ok: false, code: 'unknown_location' });
    expect(plan.ok ? '' : plan.message).toMatch(/[ก-๙]/);
    expect(planMove(map, at(FOUNTAIN), 'กฎทั้ง 5 สภาพอากาศ', ctx())).toMatchObject({ ok: false, code: 'unknown_location' });
    expect(planMove(map, at(FOUNTAIN), FOUNTAIN, ctx())).toMatchObject({ ok: false, code: 'already_here' });
  });
});
