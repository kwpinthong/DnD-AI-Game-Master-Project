import { describe, expect, it } from 'vitest';
import {
  applyAffinityDelta,
  checkNpcSpawn,
  evolutionPath,
  npcNameShown,
  rankCompanions,
  validateProposal,
  type EvolutionRule,
  type NpcProgress,
} from '../src/index.ts';
import { baseState, noEffects, proposal } from './resolution-fixtures.ts';

/** Rules written the way the server's sheet table writes them (apps/server/src/companions/evolution-rules.ts). */
const NOA: EvolutionRule = {
  to: 'SS',
  paths: [
    { alignment: 'Good', all: [{ type: 'affinity', min: 70 }, { type: 'karma', min: 70 }] },
    { alignment: 'Evil', all: [{ type: 'affinity', min: 70 }, { type: 'karma', max: -70 }] },
  ],
};
const LUCIA: EvolutionRule = {
  to: 'SS',
  paths: [
    {
      alignment: 'Neutral',
      all: [
        { type: 'affinity', min: 70 },
        { type: 'activityStreak', fromDay: 4, days: 3, periodsPerDay: 3, karmaMin: -1, karmaMax: 1 },
      ],
    },
  ],
};
const JULIAN: EvolutionRule = {
  to: 'S',
  paths: [{ alignment: null, all: [{ type: 'flag', flag: 'protect_villagers', day: 7 }, { type: 'flag', flag: 'expose_high_priest' }] }],
};
const NOCTIS: EvolutionRule = {
  to: 'S',
  paths: [{ alignment: null, all: [{ type: 'karma', max: -51 }, { type: 'flag', flag: 'despair_act', count: 3 }] }],
};
const ASTRA: EvolutionRule = {
  to: 'S',
  paths: [
    { alignment: null, all: [{ type: 'flag', flag: 'escaped_pocket_dimension' }] },
    { alignment: null, all: [{ type: 'karmaBandThrough', min: -3, max: 3, untilDay: 5 }] },
  ],
};

const none: NpcProgress = { affinity: 0, karma: 0, day: 1, flags: {}, activities: [], karmaDays: {} };

/** Three distinct periods with the NPC on each of `days`, karma `k` all day. */
function streak(days: readonly number[], k = 0): Pick<NpcProgress, 'activities' | 'karmaDays'> {
  return {
    activities: days.flatMap((day) => (['EOSORIA', 'SOLARION', 'HESPERION'] as const).map((period) => ({ day, period }))),
    karmaDays: Object.fromEntries(days.map((d) => [d, { min: k, max: k }])),
  };
}

describe('NPC companions (GEN-054, sheet NPC tab)', () => {
  it('C1: the main companion is the one with the highest affinity; a tie goes to the one saved first', () => {
    const { main, secondary } = rankCompanions([
      { npcId: 'noa', affinity: 12, seq: 1 },
      { npcId: 'elena', affinity: 30, seq: 2 },
      { npcId: 'julian', affinity: -5, seq: 3 },
    ]);
    expect(main?.npcId).toBe('elena');
    expect(secondary.map((s) => s.npcId)).toEqual(['noa', 'julian']);
    expect(rankCompanions([{ npcId: 'later', affinity: 20, seq: 5 }, { npcId: 'first', affinity: 20, seq: 2 }]).main?.npcId).toBe('first');
    expect(rankCompanions([]).main).toBeNull();
  });

  it('C2: an affinity delta of +15 in one action is rejected, not trimmed; ±10 passes inside -100..100', () => {
    const r = applyAffinityDelta(0, 15);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('out_of_range');
    expect(applyAffinityDelta(0, -11).ok).toBe(false);
    expect(applyAffinityDelta(0, 2.5).ok).toBe(false);
    expect(applyAffinityDelta(0, 10)).toEqual({ ok: true, before: 0, delta: 10, after: 10 });
    expect(applyAffinityDelta(95, 10)).toEqual({ ok: true, before: 95, delta: 10, after: 100 });
    expect(applyAffinityDelta(-95, -10)).toEqual({ ok: true, before: -95, delta: -10, after: -100 });
  });

  it('C2: a Mock AI proposal with affinity +15 in one action is rejected as a whole (Q-049)', () => {
    const proposed = proposal({ onSuccess: noEffects({ affinity: [{ npcId: 'npc-guard', delta: 15 }] }) });
    expect(validateProposal(baseState(), proposed).map((e) => [e.code, e.path])).toEqual([['out_of_range', 'onSuccess.affinity[0].delta']]);
  });

  it('C3 (Q-103 + Q-219): grades B and S hide their real name until revealed; F / A (and an evolved SS) show it from the start', () => {
    for (const grade of ['B', 'S'] as const) {
      expect(npcNameShown(grade, false)).toBe(false);
      expect(npcNameShown(grade, true)).toBe(true);
    }
    for (const grade of ['F', 'A', 'SS'] as const) expect(npcNameShown(grade, false)).toBe(true);
  });

  it('C4: Noa at affinity +70 with karma +70 takes the Good path, karma -70 the Evil path; +69 on either stays F', () => {
    expect(evolutionPath(NOA, { ...none, affinity: 70, karma: 70 })?.alignment).toBe('Good');
    expect(evolutionPath(NOA, { ...none, affinity: 70, karma: -70 })?.alignment).toBe('Evil');
    expect(evolutionPath(NOA, { ...none, affinity: 69, karma: 100 })).toBeNull();
    expect(evolutionPath(NOA, { ...none, affinity: 100, karma: 69 })).toBeNull();
    expect(evolutionPath(NOA, { ...none, affinity: 100, karma: -69 })).toBeNull();
  });

  it('C5: Lucia needs +70 and 3 distinct periods a day on days 4, 5 and 6 with karma -1..+1 throughout', () => {
    expect(evolutionPath(LUCIA, { ...none, affinity: 70, day: 6, ...streak([4, 5, 6]) })?.alignment).toBe('Neutral');
    // Any 3 days in a row from day 4 on.
    expect(evolutionPath(LUCIA, { ...none, affinity: 70, day: 9, ...streak([7, 8, 9], 1) })).not.toBeNull();
    // A day missing.
    expect(evolutionPath(LUCIA, { ...none, affinity: 70, day: 6, ...streak([4, 6]) })).toBeNull();
    expect(evolutionPath(LUCIA, { ...none, affinity: 70, day: 7, ...streak([4, 5, 7]) })).toBeNull();
    // Days before day 4 do not count.
    expect(evolutionPath(LUCIA, { ...none, affinity: 70, day: 5, ...streak([3, 4, 5]) })).toBeNull();
    // Only 2 distinct periods on one day (the same period twice counts once).
    const short = streak([4, 5, 6]);
    const activities = short.activities.filter((a) => !(a.day === 5 && a.period === 'HESPERION')).concat({ day: 5, period: 'EOSORIA' });
    expect(evolutionPath(LUCIA, { ...none, affinity: 70, day: 6, ...short, activities })).toBeNull();
    // Karma left -1..+1 on one of the days.
    const drift = streak([4, 5, 6]);
    expect(evolutionPath(LUCIA, { ...none, affinity: 70, day: 6, ...drift, karmaDays: { ...drift.karmaDays, 5: { min: 0, max: 2 } } })).toBeNull();
    // Affinity 69.
    expect(evolutionPath(LUCIA, { ...none, affinity: 69, day: 6, ...streak([4, 5, 6]) })).toBeNull();
  });

  it('C6: grade A needs every flag of its condition; a count flag needs that many', () => {
    const both = { protect_villagers: { count: 1 }, expose_high_priest: { count: 1 } };
    expect(evolutionPath(JULIAN, { ...none, flags: both })).not.toBeNull();
    expect(evolutionPath(JULIAN, { ...none, flags: { protect_villagers: { count: 1 } } })).toBeNull();
    expect(evolutionPath(NOCTIS, { ...none, karma: -51, flags: { despair_act: { count: 3 } } })).not.toBeNull();
    expect(evolutionPath(NOCTIS, { ...none, karma: -51, flags: { despair_act: { count: 2 } } })).toBeNull();
    expect(evolutionPath(NOCTIS, { ...none, karma: -50, flags: { despair_act: { count: 3 } } })).toBeNull();
  });

  it('S awaken: any one path is enough (Astra: the pocket dimension, or karma -3..+3 every day up to day 5)', () => {
    expect(evolutionPath(ASTRA, { ...none, flags: { escaped_pocket_dimension: { count: 1 } } })).not.toBeNull();
    const calm = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, { min: -3, max: 3 }]));
    expect(evolutionPath(ASTRA, { ...none, day: 5, karmaDays: calm })).not.toBeNull();
    expect(evolutionPath(ASTRA, { ...none, day: 4, karmaDays: calm })).toBeNull();
    expect(evolutionPath(ASTRA, { ...none, day: 5, karmaDays: { ...calm, 2: { min: -4, max: 0 } } })).toBeNull();
    // Day 5 itself must have been seen.
    const { 5: _day5, ...upTo4 } = calm;
    expect(evolutionPath(ASTRA, { ...none, day: 6, karmaDays: upTo4 })).toBeNull();
  });

  it('C7: a new NPC of grade SS is rejected; F / B / A / S may spawn', () => {
    expect(checkNpcSpawn('SS')?.code).toBe('grade_not_spawnable');
    expect(checkNpcSpawn('Z')?.code).toBe('grade_not_spawnable');
    for (const rank of ['F', 'B', 'A', 'S']) expect(checkNpcSpawn(rank)).toBeNull();
  });
});
