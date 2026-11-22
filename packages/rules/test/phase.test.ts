import { describe, expect, it } from 'vitest';
import {
  SeededRng,
  createPhaseState,
  phaseStep,
  rollRescue,
  turnNumber,
  wakeAfter,
  type PhaseEvent,
  type PhaseState,
  type PhaseStepResult,
  type PlayerAction,
  type PlayerResult,
  type TurnPoint,
} from '../src/index.ts';

/** GEN-052 cases, read on the GEN-063 clock: a "phase" of GEN-052 is now one turn (2 per period). */

const IDS = ['pc-a', 'pc-b', 'pc-c'] as const;

function start(overrides: Partial<Record<string, { stamina?: number; hp?: number; sleepBonus?: number }>> = {}): PhaseState {
  return createPhaseState({ players: IDS.map((id) => ({ id, ...overrides[id] })) });
}

function act(text = 'เดินดูตลาด', extra: Partial<PlayerAction> = {}): PlayerAction {
  return { text, visibility: 'public', ...extra };
}

function ok(result: PhaseStepResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function rejected(result: PhaseStepResult) {
  if (result.ok) throw new Error('expected the event to be rejected');
  return result.error.code;
}

function step(state: PhaseState, event: PhaseEvent, seed = 1): PhaseState {
  return ok(phaseStep(state, event, new SeededRng(seed))).state;
}

function submit(state: PhaseState, playerId: string, action: PlayerAction = act()): PhaseState {
  return step(state, { type: 'submit', playerId, action });
}

/** Every player who must submit and has not yet sends an action (a rough sleep in NOCTHERION, so nobody is Drowsy). */
function submitAll(state: PhaseState, action?: PlayerAction): PhaseState {
  let s = state;
  for (const id of s.order) {
    if (s.status === 'collecting' && s.players[id]!.mustSubmit && !(id in s.submissions)) {
      s = submit(s, id, action ?? (s.phase === 'NOCTHERION' ? act('นอน', { rest: true }) : act()));
    }
  }
  return s;
}

function resolve(state: PhaseState, results: Record<string, PlayerResult> = {}, seed = 1): PhaseState {
  return step(state, { type: 'resolved', results }, seed);
}

/** Submit for everyone who must, then resolve with the given results. */
function playTurn(state: PhaseState, results: Record<string, PlayerResult> = {}, action?: PlayerAction, seed = 1): PhaseState {
  return resolve(submitAll(state, action), results, seed);
}

/** Plays whole turns until the state reaches the given point. */
function playTo(state: PhaseState, day: number, phase: PhaseState['phase'], turn: TurnPoint['turn'] = 1): PhaseState {
  let s = state;
  const target = turnNumber({ day, phase, turn });
  for (let guard = 0; guard < 200 && turnNumber(s) < target; guard++) s = playTurn(s);
  expect({ day: s.day, phase: s.phase, turn: s.turn }).toEqual({ day, phase, turn });
  return s;
}

describe('C1 a turn closes when every player who can act has submitted', () => {
  it('2 of 3 submitted: still collecting; 3 of 3: closed, then the next turn after resolve', () => {
    let s = start();
    s = submit(s, 'pc-a');
    s = submit(s, 'pc-b');
    expect(s.status).toBe('collecting');
    expect(s.phase).toBe('EOSORIA');

    const closed = ok(phaseStep(s, { type: 'submit', playerId: 'pc-c', action: act() }, new SeededRng(1)));
    expect(closed.state.status).toBe('resolving');
    expect(closed.log.some((e) => e.type === 'phase_closed')).toBe(true);

    const next = resolve(closed.state);
    expect(next.status).toBe('collecting');
    expect(next.day).toBe(1);
    expect(next.phase).toBe('EOSORIA');
    expect(next.turn).toBe(2);
    expect(next.submissions).toEqual({});
  });
});

describe('C2 after NOCTHERION comes the next EOSORIA, and Stamina is not reset', () => {
  it('day 1 NOCTHERION turn 2 -> day 2 EOSORIA turn 1 with Stamina carried over', () => {
    let s = playTo(start(), 1, 'NOCTHERION', 2);
    s = submitAll(s, act('สืบเรื่องลัทธิ'));
    s = resolve(s, { 'pc-a': { stamina: 12 }, 'pc-b': { stamina: 7 }, 'pc-c': { stamina: 30 } });
    expect(s.day).toBe(2);
    expect(s.phase).toBe('EOSORIA');
    expect(s.turn).toBe(1);
    expect(s.status).toBe('collecting');
    expect(s.players['pc-a']!.stamina).toBe(12);
    expect(s.players['pc-b']!.stamina).toBe(7);
    expect(s.players['pc-c']!.stamina).toBe(30);
  });
});

describe('C8 the end of day 12 NOCTHERION is the finale; there is no day 13', () => {
  it('enters finale and rejects any further action', () => {
    const s = playTo(start(), 12, 'NOCTHERION', 2);
    expect(s.status).toBe('collecting');
    const end = ok(phaseStep(submitAll(s), { type: 'resolved', results: {} }, new SeededRng(1)));
    expect(end.state.status).toBe('finale');
    expect(end.state.day).toBe(12);
    expect(end.state.phase).toBe('NOCTHERION');
    expect(end.log).toContainEqual(expect.objectContaining({ type: 'finale' }));
    expect(rejected(phaseStep(end.state, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('game_ended');
    expect(rejected(phaseStep(end.state, { type: 'resolved', results: {} }, new SeededRng(1)))).toBe('game_ended');
  });
});

describe('C3 one Secret turn per day (outside NOCTHERION)', () => {
  const secret = act('แอบขโมยกุญแจ', { visibility: 'secret' });

  it('a Secret in EOSORIA blocks a Secret in the next turns of the day; the next day it is allowed again', () => {
    let s = start();
    s = submit(s, 'pc-a', secret);
    s = resolve(submitAll(s));
    expect(s.turn).toBe(2);
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: secret }, new SeededRng(1)))).toBe('secret_quota_used');

    s = playTo(s, 1, 'SOLARION');
    const again = phaseStep(s, { type: 'submit', playerId: 'pc-a', action: secret }, new SeededRng(1));
    expect(rejected(again)).toBe('secret_quota_used');
    // Other players and Public actions are not affected.
    s = submit(s, 'pc-b', secret);
    s = submit(s, 'pc-a', act());

    s = playTo(s, 2, 'EOSORIA');
    expect(submit(s, 'pc-a', secret).submissions['pc-a']!.visibility).toBe('secret');
  });

  it('a Secret replaced by a Public action before the turn closes does not use the quota', () => {
    let s = start();
    s = submit(s, 'pc-a', secret);
    s = submit(s, 'pc-a', act());
    s = resolve(submitAll(s));
    expect(submit(s, 'pc-a', secret).submissions['pc-a']!.visibility).toBe('secret');
  });
});

describe('C4 Stamina 0 locks the next turn and the character sleeps through it', () => {
  it('locks input, does not wait for the sleeper, and recovers +15 + on_sleep outside NOCTHERION', () => {
    let s = start({ 'pc-a': { sleepBonus: 2 } });
    const first = ok(phaseStep(submitAll(s), { type: 'resolved', results: { 'pc-a': { stamina: 0 } } }, new SeededRng(1)));
    expect(first.log).toContainEqual(
      expect.objectContaining({ type: 'exhausted', playerId: 'pc-a', sleepsAt: { day: 1, phase: 'EOSORIA', turn: 2 } }),
    );
    s = first.state;
    expect(s.turn).toBe(2);
    expect(s.players['pc-a']!.condition).toBe('exhausted');
    expect(s.players['pc-a']!.mustSubmit).toBe(false);
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('cannot_act');

    s = submit(s, 'pc-b');
    const closed = ok(phaseStep(s, { type: 'submit', playerId: 'pc-c', action: act() }, new SeededRng(1)));
    expect(closed.state.status).toBe('resolving');
    expect(closed.log).toContainEqual(expect.objectContaining({ type: 'phase_closed', asleep: [{ playerId: 'pc-a', reason: 'exhausted' }] }));

    s = resolve(closed.state);
    expect(s.phase).toBe('SOLARION');
    expect(s.players['pc-a']!.stamina).toBe(17);
    expect(s.players['pc-a']!.condition).toBe('awake');
    expect(s.players['pc-a']!.mustSubmit).toBe(true);
  });

  it('a forced sleep in NOCTHERION recovers like a night rest at the inn', () => {
    let s = playTo(start(), 1, 'HESPERION', 2);
    s = playTurn(s, { 'pc-a': { stamina: 0 } });
    expect(s.phase).toBe('NOCTHERION');
    expect(s.players['pc-a']!.condition).toBe('exhausted');
    const night = ok(phaseStep(submitAll(s), { type: 'resolved', results: { 'pc-a': { atInn: true } } }, new SeededRng(7)));
    const rec = night.log.find((e) => e.type === 'recovered');
    expect(rec).toMatchObject({ playerId: 'pc-a', kind: 'exhausted_night_inn' });
    if (rec?.type !== 'recovered') throw new Error('no recovery logged');
    expect(rec.roll).toBeGreaterThanOrEqual(15);
    expect(rec.roll).toBeLessThanOrEqual(25);
    expect(night.state.players['pc-a']!.stamina).toBe(rec.roll);
    expect(night.state.turn).toBe(2);
  });

  it('when every player is asleep the turn closes at once', () => {
    const s = playTurn(start(), { 'pc-a': { stamina: 0 }, 'pc-b': { stamina: 0 }, 'pc-c': { stamina: 0 } });
    expect(s.turn).toBe(2);
    expect(s.status).toBe('resolving');
    expect(resolve(s).players['pc-b']!.stamina).toBe(15);
  });
});

describe('C5 NOCTHERION rest at the inn: +15..25 + bonus, capped at max', () => {
  const innRest = act('นอนที่โรงเตี๊ยม', { rest: true, restAtInn: true });

  function restAtNight(stamina: number, seed: number, sleepBonus = 0) {
    let s = playTo(start({ 'pc-a': { sleepBonus } }), 1, 'NOCTHERION');
    s = submit(s, 'pc-a', innRest);
    s = submitAll(s);
    return ok(phaseStep(s, { type: 'resolved', results: { 'pc-a': { stamina } } }, new SeededRng(seed)));
  }

  it('Stamina 20 gains a 15..25 roll but stops at 30', () => {
    const r = restAtNight(20, 3);
    const rec = r.log.find((e) => e.type === 'recovered' && e.playerId === 'pc-a');
    if (rec?.type !== 'recovered') throw new Error('no recovery logged');
    expect(rec.kind).toBe('night_inn');
    expect(rec.roll).toBeGreaterThanOrEqual(15);
    expect(rec.roll).toBeLessThanOrEqual(25);
    expect(rec.stamina).toEqual({ before: 20, gain: 10, after: 30 });
    expect(r.state.players['pc-a']!.stamina).toBe(30);
  });

  it('the gain is the seeded rollRange(15, 25) plus the on_sleep bonus', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const expected = new SeededRng(seed).nextInt(15, 25);
      const r = restAtNight(0, seed, 1);
      expect(r.state.players['pc-a']!.stamina).toBe(Math.min(30, expected + 1));
    }
  });

  it('a NOCTHERION rest marks the player asleep for the feed (Q-046)', () => {
    let s = playTo(start(), 1, 'NOCTHERION');
    s = submit(s, 'pc-a', innRest);
    const closed = ok(phaseStep(s, { type: 'submit', playerId: 'pc-b', action: act() }, new SeededRng(1)));
    const last = ok(phaseStep(closed.state, { type: 'submit', playerId: 'pc-c', action: act() }, new SeededRng(1)));
    expect(last.log).toContainEqual(expect.objectContaining({ type: 'phase_closed', asleep: [{ playerId: 'pc-a', reason: 'night_rest' }] }));
  });

  it('restAtInn is only valid on a NOCTHERION rest', () => {
    const s = start();
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: innRest }, new SeededRng(1)))).toBe('invalid_action');
    const evening = playTo(s, 1, 'HESPERION', 2);
    expect(rejected(phaseStep(evening, { type: 'submit', playerId: 'pc-a', action: innRest }, new SeededRng(1)))).toBe('invalid_action');
    const night = playTo(s, 1, 'NOCTHERION');
    const noRest = act('ไปโรงเตี๊ยม', { restAtInn: true });
    expect(rejected(phaseStep(night, { type: 'submit', playerId: 'pc-a', action: noRest }, new SeededRng(1)))).toBe('invalid_action');
  });
});

describe('C6 unconscious players (HP 0, no death: Q-057) are not waited for; all out for good = game over', () => {
  it('HP 0 in EOSORIA: locked for the rest of the day, wakes next EOSORIA with the rescue roll', () => {
    let s = start();
    const ko = ok(
      phaseStep(submitAll(s), { type: 'resolved', results: { 'pc-a': { hp: 0, stamina: 0, safety: 'safe', primaryAffinity: 52 } } }, new SeededRng(1)),
    );
    expect(ko.log).toContainEqual(
      expect.objectContaining({ type: 'knocked_out', playerId: 'pc-a', wakeAt: { day: 2, phase: 'EOSORIA', turn: 1 } }),
    );
    s = ko.state;
    expect(s.players['pc-a']!.condition).toBe('unconscious');
    expect(s.players['pc-a']!.mustSubmit).toBe(false);
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('cannot_act');

    s = submit(s, 'pc-b');
    const closed = ok(phaseStep(s, { type: 'submit', playerId: 'pc-c', action: act() }, new SeededRng(1)));
    expect(closed.log).toContainEqual(expect.objectContaining({ type: 'phase_closed', unconscious: ['pc-a'], asleep: [] }));
    s = playTo(resolve(closed.state), 1, 'NOCTHERION', 2);
    expect(s.players['pc-a']!.condition).toBe('unconscious');

    const seed = 9;
    const woke = ok(phaseStep(submitAll(s), { type: 'resolved', results: {} }, new SeededRng(seed)));
    const roll = rollRescue({ safety: 'safe', primaryAffinity: 52 }, new SeededRng(seed));
    const wake = wakeAfter(roll.outcome, 0);
    expect(woke.log).toContainEqual(
      expect.objectContaining({ type: 'woke', playerId: 'pc-a', outcome: roll.outcome, rescueRoll: { d20: roll.d20, score: roll.score } }),
    );
    expect(woke.state.day).toBe(2);
    expect(woke.state.players['pc-a']).toMatchObject({ condition: 'awake', mustSubmit: true, hp: wake.hp, stamina: wake.stamina, knockedOut: null });
    // Out cold through the night counts as sleep: not Drowsy.
    expect(woke.state.players['pc-a']!.drowsy).toBeNull();
  });

  it('HP 0 in NOCTHERION: wakes at the next SOLARION (spec §12.2) and gets no night rest', () => {
    let s = playTo(start(), 1, 'NOCTHERION', 2);
    s = submit(s, 'pc-a', act('นอนที่โรงเตี๊ยม', { rest: true, restAtInn: true }));
    s = playTurn(s, { 'pc-a': { hp: 0, stamina: 4 } });
    expect(s.day).toBe(2);
    expect(s.phase).toBe('EOSORIA');
    expect(s.players['pc-a']).toMatchObject({
      condition: 'unconscious',
      stamina: 4,
      knockedOut: { wakeAt: { day: 2, phase: 'SOLARION', turn: 1 } },
    });
    s = playTo(s, 2, 'EOSORIA', 2);
    expect(s.players['pc-a']!.condition).toBe('unconscious');
    s = playTurn(s);
    expect(s.phase).toBe('SOLARION');
    expect(s.players['pc-a']!.condition).toBe('awake');
  });

  it("another player's DC 8 aid rescues: wakes as rescued with no roll", () => {
    let s = playTurn(start(), { 'pc-a': { hp: 0, stamina: 12 } });
    const aided = ok(phaseStep(submitAll(s), { type: 'resolved', results: { 'pc-a': { rescued: true } } }, new SeededRng(1)));
    expect(aided.log).toContainEqual(expect.objectContaining({ type: 'rescued_by_player', playerId: 'pc-a' }));
    s = playTo(aided.state, 2, 'EOSORIA');
    expect(s.players['pc-a']).toMatchObject({ condition: 'awake', hp: 30, stamina: 20 });
  });

  it('all unconscious but someone wakes before the end: the game goes on without waiting', () => {
    let s = playTo(start(), 5, 'EOSORIA');
    s = playTurn(s, { 'pc-a': { hp: 0 }, 'pc-b': { hp: 0 }, 'pc-c': { hp: 0 } });
    expect(s.turn).toBe(2);
    expect(s.status).toBe('resolving');
    for (let guard = 0; guard < 20 && s.status === 'resolving'; guard++) s = resolve(s);
    expect(s.day).toBe(6);
    expect(s.status).toBe('collecting');
    expect(IDS.every((id) => s.players[id]!.condition === 'awake')).toBe(true);
  });

  it('all unconscious with nobody able to wake before the end of day 12: game over', () => {
    let s = playTo(start(), 12, 'EOSORIA');
    s = playTurn(s, { 'pc-a': { hp: 0 }, 'pc-b': { hp: 0 } });
    expect(s.status).toBe('collecting');
    const end = ok(phaseStep(submitAll(s), { type: 'resolved', results: { 'pc-c': { hp: 0 } } }, new SeededRng(1)));
    expect(end.state.status).toBe('game_over');
    expect(end.log).toContainEqual(expect.objectContaining({ type: 'game_over', reason: 'all_unconscious' }));
    expect(rejected(phaseStep(end.state, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('game_ended');
  });
});

describe('purity: (state, event, rng) -> state + log, so a stored game replays', () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
      for (const v of Object.values(value)) deepFreeze(v);
      Object.freeze(value);
    }
    return value;
  }

  it('never mutates its input and gives the same result for the same events and seeds', () => {
    const events: PhaseEvent[] = [
      ...IDS.map((playerId) => ({ type: 'submit' as const, playerId, action: act() })),
      { type: 'resolved', results: { 'pc-a': { hp: 0 }, 'pc-b': { stamina: 0 } } },
      ...['pc-c'].map((playerId) => ({ type: 'submit' as const, playerId, action: act('พัก', { rest: true }) })),
      { type: 'resolved', results: {} },
      ...['pc-b', 'pc-c'].map((playerId) => ({ type: 'submit' as const, playerId, action: act('งีบ', { rest: true }) })),
      { type: 'resolved', results: {} },
    ];
    const run = () => {
      let s = deepFreeze(start());
      const logs = [];
      for (const [i, e] of events.entries()) {
        const r = ok(phaseStep(s, deepFreeze(e), new SeededRng(100 + i)));
        s = deepFreeze(r.state);
        logs.push(r.log);
      }
      return { s, logs };
    };
    const first = run();
    expect({ day: first.s.day, phase: first.s.phase, turn: first.s.turn }).toEqual({ day: 1, phase: 'SOLARION', turn: 2 });
    expect(JSON.parse(JSON.stringify(first))).toEqual(run());
  });
});

describe('C7 resubmitting before the turn closes replaces the action; during resolve it is rejected', () => {
  it('replaces the earlier action', () => {
    let s = start();
    s = submit(s, 'pc-a', act('ไปวิหาร'));
    const replaced = ok(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act('ไปตลาด') }, new SeededRng(1)));
    expect(replaced.state.submissions['pc-a']!.text).toBe('ไปตลาด');
    expect(Object.keys(replaced.state.submissions)).toEqual(['pc-a']);
    expect(replaced.log).toContainEqual(expect.objectContaining({ type: 'submitted', playerId: 'pc-a', replaced: true }));
  });

  it('rejects a submit while the turn is resolving and keeps the state', () => {
    const s = submitAll(start());
    expect(s.status).toBe('resolving');
    const result = phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act('เปลี่ยนใจ') }, new SeededRng(1));
    expect(rejected(result)).toBe('not_collecting');
    expect(s.submissions['pc-a']!.text).toBe('เดินดูตลาด');
  });
});
