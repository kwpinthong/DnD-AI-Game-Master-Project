import { describe, expect, it } from 'vitest';
import {
  SeededRng,
  createPhaseState,
  phaseStep,
  turnNumber,
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

// GEN-070 replaced the +15 / Rest_Quality forced sleep with a forced REST of +6 (see crisis.test.ts).
describe('C4 Stamina 0 locks the next turn and the character sleeps through it', () => {
  it('locks input, does not wait for the sleeper, and recovers +6 (GEN-070)', () => {
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
    expect(s.players['pc-a']!.stamina).toBe(6);
    expect(s.players['pc-a']!.condition).toBe('awake');
    expect(s.players['pc-a']!.mustSubmit).toBe(true);
  });

  it('a forced sleep in NOCTHERION counts as sleeping that night (not Drowsy)', () => {
    let s = playTo(start(), 1, 'HESPERION', 2);
    s = playTurn(s, { 'pc-a': { stamina: 0 } });
    expect(s.players['pc-a']!.condition).toBe('exhausted');
    // Awake again for NOCTHERION turn 2, which pc-a spends acting, not sleeping.
    s = playTurn(s);
    s = resolve(submitAll(s, act()));
    expect(s.day).toBe(2);
    expect(s.players['pc-a']!.drowsy).toBeNull();
  });

  it('when every player is asleep the turn closes at once', () => {
    const s = playTurn(start(), { 'pc-a': { stamina: 0 }, 'pc-b': { stamina: 0 }, 'pc-c': { stamina: 0 } });
    expect(s.turn).toBe(2);
    expect(s.status).toBe('resolving');
    expect(resolve(s).players['pc-b']!.stamina).toBe(6);
  });
});

// Q-218 replaced GEN-052's inn +rollRange(15, 25): a night rest recovers the place's Rest_Quality (the inn is good, 25).
describe('C5 NOCTHERION rest at the inn: Rest_Quality good +25 + bonus, capped at max', () => {
  const innRest = act('นอนที่โรงเตี๊ยม', { rest: true });

  function restAtNight(stamina: number, seed: number, sleepBonus = 0) {
    let s = playTo(start({ 'pc-a': { sleepBonus } }), 1, 'NOCTHERION');
    s = submit(s, 'pc-a', innRest);
    s = submitAll(s);
    return ok(phaseStep(s, { type: 'resolved', results: { 'pc-a': { stamina, restQuality: 'good', restSite: 'inn' } } }, new SeededRng(seed)));
  }

  it('Stamina 20 gains 25 but stops at 30', () => {
    const r = restAtNight(20, 3);
    const rec = r.log.find((e) => e.type === 'recovered' && e.playerId === 'pc-a');
    if (rec?.type !== 'recovered') throw new Error('no recovery logged');
    expect(rec).toMatchObject({ kind: 'night_rest', site: 'inn' });
    expect(rec.stamina).toEqual({ before: 20, gain: 10, after: 30 });
    expect(r.state.players['pc-a']!.stamina).toBe(30);
  });

  it('the gain is 25 plus the on_sleep bonus, whatever the seed', () => {
    for (const seed of [1, 2, 3, 4]) expect(restAtNight(0, seed, 1).state.players['pc-a']!.stamina).toBe(26);
  });

  it('a NOCTHERION rest marks the player asleep for the feed (Q-046)', () => {
    let s = playTo(start(), 1, 'NOCTHERION');
    s = submit(s, 'pc-a', innRest);
    const closed = ok(phaseStep(s, { type: 'submit', playerId: 'pc-b', action: act() }, new SeededRng(1)));
    const last = ok(phaseStep(closed.state, { type: 'submit', playerId: 'pc-c', action: act() }, new SeededRng(1)));
    expect(last.log).toContainEqual(expect.objectContaining({ type: 'phase_closed', asleep: [{ playerId: 'pc-a', reason: 'night_rest' }] }));
  });
});

// GEN-070 replaced the GEN-052 knock-out (out until the next day + rescue roll, Q-057 no death): see crisis.test.ts.
describe('C6 unconscious players (HP 0) are not waited for', () => {
  it('HP 0: locked the next turn, the turn closes without them; out cold through NOCTHERION is sleep (not Drowsy)', () => {
    let s = playTo(start(), 1, 'HESPERION', 2);
    s = playTurn(s, { 'pc-a': { hp: 0, stamina: 0 } });
    expect(s.players['pc-a']!.condition).toBe('unconscious');
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('cannot_act');

    s = submit(s, 'pc-b', act('นอน', { rest: true }));
    const closed = ok(phaseStep(s, { type: 'submit', playerId: 'pc-c', action: act('นอน', { rest: true }) }, new SeededRng(1)));
    expect(closed.log).toContainEqual(expect.objectContaining({ type: 'phase_closed', unconscious: ['pc-a'] }));
    s = playTurn(resolve(closed.state));
    expect(s.day).toBe(2);
    expect(s.players['pc-a']!.drowsy).toBeNull();
  });

  it('a game that ended rejects every submit', () => {
    let s = playTurn(start(), { 'pc-a': { hp: 0 }, 'pc-b': { hp: 0 }, 'pc-c': { hp: 0 } });
    s = resolve(s, { 'pc-a': { executed: true }, 'pc-b': { executed: true }, 'pc-c': { executed: true } });
    expect(s.status).toBe('game_over');
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('game_ended');
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

describe('ISK-018 leave (a kicked player)', () => {
  it('drops the seat and the draft; the turn closes once nobody left is waited for', () => {
    const s = submit(submit(start(), 'pc-a'), 'pc-b');
    const left = step(s, { type: 'leave', playerId: 'pc-c' });
    expect(left.status).toBe('resolving');
    expect(left.order).toEqual(['pc-a', 'pc-b']);
    expect(left.players['pc-c']).toBeUndefined();

    const drafted = step(submit(start(), 'pc-a'), { type: 'leave', playerId: 'pc-a' });
    expect(drafted.status).toBe('collecting');
    expect(drafted.submissions).toEqual({});
  });

  it('while resolving only drops the seat; an unknown player is refused; the last one leaving does not close an empty turn', () => {
    const resolving = step(submitAll(start()), { type: 'leave', playerId: 'pc-b' });
    expect(resolving).toMatchObject({ status: 'resolving', order: ['pc-a', 'pc-c'] });
    expect(rejected(phaseStep(start(), { type: 'leave', playerId: 'nobody' }, new SeededRng(1)))).toBe('unknown_player');

    let alone = start();
    for (const id of IDS) alone = step(alone, { type: 'leave', playerId: id });
    expect(alone).toMatchObject({ status: 'collecting', order: [] });
  });
});
