import { describe, expect, it } from 'vitest';
import { PERIODS, RANK_TIER, TIER_CAP, unlockPath, type Period, type SkillProgress, type SkillUnlockRule } from '../src/index.ts';

/** GEN-055: the sheet's Condition column as unlock rules (pure judge). */

const NONE: SkillProgress = { day: 1, karma: 0, skills: [], holding: [], flags: {}, activities: [], karmaDays: {} };
const progress = (p: Partial<SkillProgress>): SkillProgress => ({ ...NONE, ...p });

/** `activity` in `count` distinct periods of `day` (EOSORIA first). */
const on = (activity: string, day: number, count = 3) =>
  PERIODS.slice(0, count).map((period: Period) => ({ activity, day, period }));

const FIRST_LIGHT: SkillUnlockRule = {
  paths: [
    { source: 'condition', all: [{ type: 'streak', activity: 'verb:PRAY', days: 3, periodsPerDay: 3 }] },
    {
      source: 'item:Chalice of the First Dawn',
      all: [
        { type: 'holding', item: 'Chalice of the First Dawn' },
        { type: 'flag', flag: 'chalice_helped_others', count: 3 },
        { type: 'periods', activity: 'verb:PRAY', count: 3 },
        { type: 'streak', activity: 'verb:PRAY', days: 2, periodsPerDay: 3 },
      ],
    },
  ],
};

const ORDO: SkillUnlockRule = {
  paths: [{ source: 'condition', all: [{ type: 'streak', activity: 'evil', days: 3, periodsPerDay: 3 }, { type: 'karma', max: -91 }] }],
};

const GRACE: SkillUnlockRule = {
  paths: [{ source: 'condition', all: [{ type: 'skillOf', rank: 'A', alignment: 'Good' }, { type: 'karma', min: 60 }] }],
};

describe('GEN-055 skill unlock rules', () => {
  it('C1: PRAY in 3 distinct periods a day for 3 days in a row unlocks The First Light', () => {
    const three = [...on('verb:PRAY', 1), ...on('verb:PRAY', 2), ...on('verb:PRAY', 3)];
    expect(unlockPath(FIRST_LIGHT, progress({ day: 3, activities: three }))?.source).toBe('condition');
    // Two periods on day 3 is not a full day yet.
    expect(unlockPath(FIRST_LIGHT, progress({ day: 3, activities: [...on('verb:PRAY', 1), ...on('verb:PRAY', 2), ...on('verb:PRAY', 3, 2)] }))).toBeNull();
    // The same period twice counts once.
    const twice = [...on('verb:PRAY', 1), ...on('verb:PRAY', 2), ...on('verb:PRAY', 3, 2), { activity: 'verb:PRAY', day: 3, period: 'EOSORIA' as const }];
    expect(unlockPath(FIRST_LIGHT, progress({ day: 3, activities: twice }))).toBeNull();
    // Another activity does not count.
    expect(unlockPath(FIRST_LIGHT, progress({ day: 3, activities: [...on('verb:PRAY', 1), ...on('verb:PRAY', 2), ...on('act', 3)] }))).toBeNull();
  });

  it('C1: a missed day starts the count again', () => {
    const gap = [...on('verb:PRAY', 1), ...on('verb:PRAY', 2), ...on('verb:PRAY', 4), ...on('verb:PRAY', 5)];
    expect(unlockPath(FIRST_LIGHT, progress({ day: 5, activities: gap }))).toBeNull();
    expect(unlockPath(FIRST_LIGHT, progress({ day: 6, activities: [...gap, ...on('verb:PRAY', 6)] }))?.source).toBe('condition');
  });

  it('C2: ORDO TENEBRIS needs karma below -90 on top of the 3-day streak', () => {
    const evil = [...on('evil', 1), ...on('evil', 2), ...on('evil', 3)];
    expect(unlockPath(ORDO, progress({ day: 3, activities: evil, karma: -89 }))).toBeNull();
    expect(unlockPath(ORDO, progress({ day: 3, activities: evil, karma: -90 }))).toBeNull();
    expect(unlockPath(ORDO, progress({ day: 3, activities: evil, karma: -91 }))?.source).toBe('condition');
    expect(unlockPath(ORDO, progress({ day: 3, activities: evil.slice(1), karma: -95 }))).toBeNull();
  });

  it('C3: Grace of Dawn needs a Rank A Good skill as well as karma +60', () => {
    expect(unlockPath(GRACE, progress({ karma: 60 }))).toBeNull();
    expect(unlockPath(GRACE, progress({ karma: 60, skills: [{ name: 'Venom of Despair', rank: 'A', alignment: 'Evil' }] }))).toBeNull();
    expect(unlockPath(GRACE, progress({ karma: 60, skills: [{ name: 'Ward of Light', rank: 'B', alignment: 'Good' }] }))).toBeNull();
    const aegis = { name: 'Aegis of Faith', rank: 'A' as const, alignment: 'Good' as const };
    expect(unlockPath(GRACE, progress({ karma: 59, skills: [aegis] }))).toBeNull();
    expect(unlockPath(GRACE, progress({ karma: 60, skills: [aegis] }))?.source).toBe('condition');
  });

  it('C4: holding the Chalice, 3 helps and 3 prayers cut The First Light to 2 days', () => {
    const twoDays = [...on('verb:PRAY', 1), ...on('verb:PRAY', 2)];
    const chalice = { holding: ['Chalice of the First Dawn'], flags: { chalice_helped_others: 3 } };
    expect(unlockPath(FIRST_LIGHT, progress({ day: 2, activities: twoDays, ...chalice }))?.source).toBe('item:Chalice of the First Dawn');
    // Without the item, or with 2 helps, 2 days are not enough.
    expect(unlockPath(FIRST_LIGHT, progress({ day: 2, activities: twoDays, flags: { chalice_helped_others: 3 } }))).toBeNull();
    expect(unlockPath(FIRST_LIGHT, progress({ day: 2, activities: twoDays, holding: chalice.holding, flags: { chalice_helped_others: 2 } }))).toBeNull();
    // 1 day is still not enough.
    expect(unlockPath(FIRST_LIGHT, progress({ day: 1, activities: on('verb:PRAY', 1), ...chalice }))).toBeNull();
  });

  it('the other condition shapes: periods, periodRun across the night, karmaDays, streak karma band', () => {
    const steadyEvening: SkillUnlockRule = { paths: [{ source: 'condition', all: [{ type: 'periods', activity: 'karma_steady', count: 1, period: 'HESPERION' }] }] };
    expect(unlockPath(steadyEvening, progress({ activities: [{ activity: 'karma_steady', day: 1, period: 'EOSORIA' }] }))).toBeNull();
    expect(unlockPath(steadyEvening, progress({ activities: [{ activity: 'karma_steady', day: 1, period: 'HESPERION' }] }))).not.toBeNull();

    const run: SkillUnlockRule = { paths: [{ source: 'condition', all: [{ type: 'periodRun', activity: 'good_public', periods: 2 }] }] };
    expect(unlockPath(run, progress({ day: 2, activities: [{ activity: 'good_public', day: 1, period: 'EOSORIA' }, { activity: 'good_public', day: 1, period: 'HESPERION' }] }))).toBeNull();
    expect(unlockPath(run, progress({ day: 2, activities: [{ activity: 'good_public', day: 1, period: 'NOCTHERION' }, { activity: 'good_public', day: 2, period: 'EOSORIA' }] }))).not.toBeNull();

    const zero: SkillUnlockRule = { paths: [{ source: 'condition', all: [{ type: 'karmaDays', min: -5, max: 5, days: 2 }] }] };
    // Only finished days count: day 3 is still running.
    expect(unlockPath(zero, progress({ day: 3, karmaDays: { 2: { min: 0, max: 5 }, 3: { min: 0, max: 0 } } }))).toBeNull();
    expect(unlockPath(zero, progress({ day: 3, karmaDays: { 1: { min: -5, max: 0 }, 2: { min: 0, max: 5 } } }))).not.toBeNull();
    expect(unlockPath(zero, progress({ day: 3, karmaDays: { 1: { min: -6, max: 0 }, 2: { min: 0, max: 5 } } }))).toBeNull();

    const untouched: SkillUnlockRule = {
      paths: [{ source: 'condition', all: [{ type: 'streak', activity: 'act', days: 3, periodsPerDay: 3, fromDay: 4, karmaMin: -1, karmaMax: 1 }] }],
    };
    const acts = [...on('act', 3), ...on('act', 4), ...on('act', 5), ...on('act', 6)];
    const band = { 3: { min: 0, max: 0 }, 4: { min: 0, max: 1 }, 5: { min: -1, max: 0 }, 6: { min: 0, max: 0 } };
    expect(unlockPath(untouched, progress({ day: 6, activities: acts, karmaDays: band }))).not.toBeNull();
    expect(unlockPath(untouched, progress({ day: 6, activities: acts, karmaDays: { ...band, 5: { min: -2, max: 0 } } }))).toBeNull();
    expect(unlockPath(untouched, progress({ day: 5, activities: acts.slice(0, 9), karmaDays: band }))).toBeNull();
  });

  it('Rank → judged tier: B +2, A +3, S / SS +5 (Q-114, Q-122)', () => {
    expect([TIER_CAP[RANK_TIER.B], TIER_CAP[RANK_TIER.A], TIER_CAP[RANK_TIER.S], TIER_CAP[RANK_TIER.SS]]).toEqual([2, 3, 5, 5]);
  });
});
