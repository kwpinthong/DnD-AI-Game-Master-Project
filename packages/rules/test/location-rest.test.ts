import { describe, expect, it } from 'vitest';
import {
  createPhaseState,
  phaseStep,
  REST_QUALITY_STAMINA,
  resolveAction,
  resolvePhaseActions,
  SeededRng,
  TRAIN,
  type CrossPlayerState,
  type Period,
  type PhaseState,
  type PhaseStepResult,
  type PlayerAction,
  type PlayerResult,
} from '../src/index.ts';
import { baseState, noEffects, proposal } from './resolution-fixtures.ts';

/**
 * GEN-069 location actions in the phase engine, Q-209 start passives that add to a rest, and Q-218 night rest
 * by the place's Rest_Quality. One player, so every submit closes the turn.
 */

function ok(result: PhaseStepResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function at(phase: Period, turn: 1 | 2 = 1, player: { hp?: number; hpMax?: number; stamina?: number; sleepBonus?: number } = {}): PhaseState {
  return { ...createPhaseState({ players: [{ id: 'pc-a', ...player }] }), phase, turn };
}

/** Sends `action`, then resolves the turn with `result` for pc-a. */
function play(state: PhaseState, action: PlayerAction, result: PlayerResult = {}, seed = 1) {
  const closed = ok(phaseStep(state, { type: 'submit', playerId: 'pc-a', action }, new SeededRng(seed)));
  expect(closed.state.status).toBe('resolving');
  return ok(phaseStep(closed.state, { type: 'resolved', results: { 'pc-a': result } }, new SeededRng(seed)));
}

const rest: PlayerAction = { text: 'พัก', visibility: 'public', rest: true };
const train: PlayerAction = { text: 'ฝึกซ้อมที่ลานกิลด์', visibility: 'public', train: true };
const me = (r: { state: PhaseState }) => r.state.players['pc-a']!;

describe('Q-218: a night rest recovers Stamina by the place\'s Rest_Quality', () => {
  it('poor 15 / normal 20 / good 25 / excellent 30, plus the on_sleep bonus, capped at 30', () => {
    expect(REST_QUALITY_STAMINA).toEqual({ poor: 15, normal: 20, good: 25, excellent: 30 });
    for (const [quality, gain] of [['poor', 15], ['normal', 20], ['good', 25], ['excellent', 30]] as const) {
      const r = play(at('NOCTHERION', 1, { stamina: 0 }), rest, { restQuality: quality });
      expect(me(r).stamina, quality).toBe(gain);
      expect(r.log).toContainEqual(expect.objectContaining({ type: 'recovered', kind: 'night_rest', stamina: { before: 0, gain, after: gain } }));
    }
    expect(me(play(at('NOCTHERION', 1, { stamina: 0, sleepBonus: 2 }), rest, { restQuality: 'normal' })).stamina).toBe(22);
    expect(me(play(at('NOCTHERION', 1, { stamina: 20 }), rest, { restQuality: 'excellent' })).stamina).toBe(30);
  });

  it('a place without a quality sleeps like the old rough rest (poor 15)', () => {
    expect(me(play(at('NOCTHERION', 1, { stamina: 0 }), rest)).stamina).toBe(15);
  });

  it('a forced sleep in NOCTHERION (Stamina 0 last turn) is the GEN-070 forced REST +6, whatever the quality', () => {
    let s = at('HESPERION', 2, { stamina: 5 });
    s = play(s, { text: 'วิ่ง', visibility: 'public' }, { stamina: 0 }).state;
    expect(s.phase).toBe('NOCTHERION');
    expect(s.players['pc-a']!.condition).toBe('exhausted');
    expect(s.status).toBe('resolving');
    const r = ok(phaseStep(s, { type: 'resolved', results: { 'pc-a': { restQuality: 'good' } } }, new SeededRng(1)));
    expect(me(r).stamina).toBe(6);
    expect(r.log).toContainEqual(expect.objectContaining({ type: 'recovered', kind: 'exhausted' }));
  });

  it('a day rest stays +8 whatever the quality', () => {
    expect(me(play(at('SOLARION', 1, { stamina: 10 }), rest, { restQuality: 'excellent' })).stamina).toBe(18);
  });
});

describe('GEN-069 C1 / C5 / C6: REST at the inn', () => {
  it('C1: a day REST at the inn recovers Stamina +10, never above 30', () => {
    expect(me(play(at('EOSORIA', 1, { stamina: 10 }), rest, { restSite: 'inn' })).stamina).toBe(20);
    expect(me(play(at('EOSORIA', 1, { stamina: 25 }), rest, { restSite: 'inn' })).stamina).toBe(30);
  });

  it('C1: a night REST at the inn follows its Rest_Quality (good 25) and HP +10', () => {
    const r = play(at('NOCTHERION', 1, { stamina: 0, hp: 10, hpMax: 30 }), rest, { restSite: 'inn', restQuality: 'good' });
    expect(me(r)).toMatchObject({ stamina: 25, hp: 20 });
  });

  it('C5: a REST bonus (the dishwasher +2 at the inn) adds to the inn: +12', () => {
    expect(me(play(at('EOSORIA', 1, { stamina: 10 }), rest, { restSite: 'inn', restBonus: { stamina: 2 } })).stamina).toBe(22);
  });

  it('C6: a REST anywhere else is the normal rest: +8 by day, HP +5 at night', () => {
    expect(me(play(at('EOSORIA', 1, { stamina: 10 }), rest)).stamina).toBe(18);
    expect(me(play(at('NOCTHERION', 1, { stamina: 10, hp: 10, hpMax: 30 }), rest, { restQuality: 'normal' }))).toMatchObject({ stamina: 30, hp: 15 });
  });
});

describe('GEN-069 C2: resting at the infirmary', () => {
  it('one turn: HP +15 and Stamina +8', () => {
    const r = play(at('EOSORIA', 1, { stamina: 10, hp: 5, hpMax: 30 }), rest, { restSite: 'clinic' });
    expect(me(r)).toMatchObject({ hp: 20, stamina: 18 });
  });

  it('both turns of the same period: HP back to Max HP', () => {
    let r = play(at('SOLARION', 1, { stamina: 10, hp: 1, hpMax: 30 }), rest, { restSite: 'clinic' });
    expect(me(r).hp).toBe(16);
    expect(r.state.turn).toBe(2);
    r = play(r.state, rest, { restSite: 'clinic' });
    expect(me(r)).toMatchObject({ hp: 30, stamina: 26 });
  });

  it('turn 2 of a period after a turn-2 rest in the period before is not "both turns"', () => {
    let r = play(at('EOSORIA', 2, { stamina: 10, hp: 1, hpMax: 45 }), rest, { restSite: 'clinic' });
    expect(r.state.phase).toBe('SOLARION');
    r = play(r.state, { text: 'เดินเล่น', visibility: 'public' });
    r = play(r.state, rest, { restSite: 'clinic' });
    expect(me(r).hp).toBe(1 + 15 + 15);
  });

  it('a night rest at the infirmary: its quality (excellent 30) and HP +15', () => {
    const r = play(at('NOCTHERION', 1, { stamina: 0, hp: 5, hpMax: 30 }), rest, { restSite: 'clinic', restQuality: 'excellent' });
    expect(me(r)).toMatchObject({ stamina: 30, hp: 20 });
  });
});

describe('Q-209: start passives that add to a rest', () => {
  it('HP / Stamina bonus applies only on a turn the player rests', () => {
    expect(me(play(at('EOSORIA', 1, { stamina: 10, hp: 5, hpMax: 30 }), rest, { restBonus: { hp: 5 } }))).toMatchObject({ hp: 10, stamina: 18 });
    expect(me(play(at('EOSORIA', 1, { stamina: 10, hp: 5, hpMax: 30 }), { text: 'เดินเล่น', visibility: 'public' }, { restBonus: { hp: 5 } }))).toMatchObject({ hp: 5, stamina: 10 });
  });

  it('a negative or broken bonus is refused like any bad result', () => {
    const closed = ok(phaseStep(at('EOSORIA'), { type: 'submit', playerId: 'pc-a', action: rest }, new SeededRng(1)));
    const bad = phaseStep(closed.state, { type: 'resolved', results: { 'pc-a': { restBonus: { hp: -3 } } } }, new SeededRng(1));
    expect(bad.ok ? null : bad.error.code).toBe('invalid_result');
  });
});

describe('GEN-069 C3: TRAIN at the guild (Q-088: once a day, Max HP up to 45)', () => {
  it('Max HP 30 → 33; HP stays', () => {
    expect(TRAIN).toEqual({ hpMax: 3, hpMaxCap: 45 });
    const r = play(at('EOSORIA', 1, { hp: 20, hpMax: 30 }), train);
    expect(me(r)).toMatchObject({ hpMax: 33, hp: 20 });
    expect(r.log).toContainEqual(expect.objectContaining({ type: 'trained', playerId: 'pc-a', hpMax: { before: 30, after: 33 } }));
  });

  it('a second TRAIN the same day is refused; the next day it works again', () => {
    let s = play(at('EOSORIA', 1, { hpMax: 30 }), train).state;
    const again = phaseStep(s, { type: 'submit', playerId: 'pc-a', action: train }, new SeededRng(1));
    expect(again.ok ? null : again.error.code).toBe('train_used');
    s = { ...s, day: 2 };
    expect(me(play(s, train)).hpMax).toBe(36);
  });

  it('Max HP 45 is refused (the ceiling); 44 becomes 45, not 47', () => {
    const capped = phaseStep(at('EOSORIA', 1, { hpMax: 45 }), { type: 'submit', playerId: 'pc-a', action: train }, new SeededRng(1));
    expect(capped.ok ? null : capped.error.code).toBe('train_cap');
    expect(me(play(at('EOSORIA', 1, { hpMax: 44 }), train)).hpMax).toBe(45);
  });

  it('TRAIN and REST in one action is invalid', () => {
    const both = phaseStep(at('EOSORIA', 1, { hpMax: 30 }), { type: 'submit', playerId: 'pc-a', action: { ...train, rest: true } }, new SeededRng(1));
    expect(both.ok ? null : both.error.code).toBe('invalid_action');
  });

  it('knocked out on the TRAIN turn: no Max HP', () => {
    expect(me(play(at('EOSORIA', 1, { hpMax: 30 }), train, { hp: 0 })).hpMax).toBe(30);
  });
});

describe('GEN-069 C4: a Public action at the fountain moves Reputation ×1.5 (rounded down, GEN-042)', () => {
  const repAction = (repDelta: number, visibility: 'public' | 'secret' = 'public') =>
    proposal({ check: { type: 'none' }, modifiers: [], visibility, onSuccess: noEffects({ repDelta }), repDeltaIfCaught: 0 });

  it('resolveAction: 4 → 6, 3 → 4, -3 → -4; a Secret is not scaled', () => {
    const repAfter = (repDelta: number, visibility: 'public' | 'secret' = 'public') => {
      const r = resolveAction({ state: baseState(), proposal: repAction(repDelta, visibility), publicRepScale: 1.5 }, new SeededRng(1));
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      return r.state.actor.rep;
    };
    expect(repAfter(4)).toBe(6);
    expect(repAfter(3)).toBe(4);
    expect(repAfter(-3)).toBe(-4);
    expect(repAfter(0)).toBe(0);
  });

  it('resolvePhaseActions: only the actor standing at a scaled place', () => {
    const actor = { ...baseState().actor, seat: 0, remoteReach: [] };
    const state: CrossPlayerState = {
      players: { a: { ...actor, id: 'a', seat: 0, locationId: 'fountain' }, b: { ...actor, id: 'b', seat: 1, locationId: 'inn' } },
      npcs: {},
      publicRepScale: { fountain: 1.5 },
    };
    const action = (actorId: string) => ({ actorId, proposal: { ...repAction(4), actionId: `act-${actorId}`, witnessNpcIds: [] }, targetPlayer: null, moveTo: null, awareness: 'normal' as const });
    const r = resolvePhaseActions({ state, actions: [action('a'), action('b')] }, new SeededRng(1));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.state.players['a']!.rep).toBe(6);
    expect(r.state.players['b']!.rep).toBe(4);
  });
});
