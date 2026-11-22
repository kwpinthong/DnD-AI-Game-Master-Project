import { describe, expect, it } from 'vitest';
import {
  DROWSY_STATUS,
  GAME_DAYS,
  PERIODS,
  SeededRng,
  TOTAL_TURNS,
  computeStat,
  createPhaseState,
  gainStamina,
  nextPoint,
  phaseStep,
  restorePhaseState,
  turnNumber,
  type ActorState,
  type NewPlayer,
  type PhaseState,
  type PhaseStepResult,
  type PlayerAction,
  type PlayerResult,
  type TurnPoint,
} from '../src/index.ts';

/** GEN-063: 12 days x 4 periods (EOSORIA / SOLARION / HESPERION / NOCTHERION) x 2 turns. */

const IDS = ['pc-a', 'pc-b', 'pc-c'] as const;

function start(overrides: Partial<Record<string, Omit<NewPlayer, 'id'>>> = {}): PhaseState {
  return createPhaseState({ players: IDS.map((id) => ({ id, ...overrides[id] })) });
}

function act(text = 'เดินสำรวจตลาด', extra: Partial<PlayerAction> = {}): PlayerAction {
  return { text, visibility: 'public', ...extra };
}
const sleep = act('นอนพัก', { rest: true });
const secret = act('แอบสะกดรอย', { visibility: 'secret' });

function ok(result: PhaseStepResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function rejected(result: PhaseStepResult) {
  if (result.ok) throw new Error('expected the event to be rejected');
  return result.error.code;
}

function submit(state: PhaseState, playerId: string, action: PlayerAction = act()): PhaseState {
  return ok(phaseStep(state, { type: 'submit', playerId, action }, new SeededRng(1))).state;
}

/** Everyone who must and has not yet sends: a rest in NOCTHERION (so nobody turns Drowsy), else `action`. */
function submitAll(state: PhaseState, action?: PlayerAction): PhaseState {
  let s = state;
  for (const id of s.order) {
    if (s.status !== 'collecting' || !s.players[id]!.mustSubmit || id in s.submissions) continue;
    s = submit(s, id, action ?? (s.phase === 'NOCTHERION' ? sleep : act()));
  }
  return s;
}

function resolve(state: PhaseState, results: Record<string, PlayerResult> = {}, seed = 1): PhaseState {
  return ok(phaseStep(state, { type: 'resolved', results }, new SeededRng(seed))).state;
}

function playTurn(state: PhaseState, results: Record<string, PlayerResult> = {}, action?: PlayerAction): PhaseState {
  return resolve(submitAll(state, action), results);
}

const at = (s: PhaseState): TurnPoint => ({ day: s.day, phase: s.phase, turn: s.turn });

function playTo(state: PhaseState, point: TurnPoint): PhaseState {
  let s = state;
  for (let guard = 0; guard < 200 && turnNumber(at(s)) < turnNumber(point); guard++) s = playTurn(s);
  expect(at(s)).toEqual(point);
  return s;
}

describe('C1 each period has 2 turns; a turn closes when every player who can act has sent', () => {
  it('day 1 EOSORIA turn 1 -> EOSORIA turn 2 -> SOLARION turn 1', () => {
    let s = start();
    expect(at(s)).toEqual({ day: 1, phase: 'EOSORIA', turn: 1 });
    s = submit(s, 'pc-a');
    s = submit(s, 'pc-b');
    expect(s.status).toBe('collecting');
    s = submit(s, 'pc-c');
    expect(s.status).toBe('resolving');
    s = resolve(s);
    expect(at(s)).toEqual({ day: 1, phase: 'EOSORIA', turn: 2 });
    expect(s.status).toBe('collecting');
    expect(s.submissions).toEqual({});
    s = playTurn(s);
    expect(at(s)).toEqual({ day: 1, phase: 'SOLARION', turn: 1 });
  });

  it('periods run EOSORIA -> SOLARION -> HESPERION -> NOCTHERION', () => {
    expect(PERIODS).toEqual(['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION']);
    expect(nextPoint({ day: 1, phase: 'SOLARION', turn: 2 })).toEqual({ day: 1, phase: 'HESPERION', turn: 1 });
    expect(nextPoint({ day: 1, phase: 'HESPERION', turn: 2 })).toEqual({ day: 1, phase: 'NOCTHERION', turn: 1 });
  });
});

describe('C2 after NOCTHERION turn 2 comes the next day; 96 turns, then the finale', () => {
  it('NOCTHERION turn 2 -> next day EOSORIA turn 1', () => {
    let s = playTo(start(), { day: 3, phase: 'NOCTHERION', turn: 2 });
    s = playTurn(s);
    expect(at(s)).toEqual({ day: 4, phase: 'EOSORIA', turn: 1 });
  });

  it('the whole game is 96 turns; after day 12 NOCTHERION turn 2 the finale starts and there is no day 13', () => {
    expect(TOTAL_TURNS).toBe(96);
    expect(GAME_DAYS).toBe(12);
    let s = start();
    let turns = 0;
    while (s.status !== 'finale' && turns < 200) {
      s = playTurn(s);
      turns++;
    }
    expect(turns).toBe(96);
    expect(at(s)).toEqual({ day: 12, phase: 'NOCTHERION', turn: 2 });
    expect(nextPoint(at(s))).toBeNull();
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('game_ended');
  });
});

describe('C3 NOCTHERION gives one free Secret turn', () => {
  it('after the day Secret is used: one Secret in NOCTHERION is allowed, a second the same night is refused', () => {
    let s = start();
    s = submit(s, 'pc-a', secret);
    s = playTurn(s);
    // The day quota is used: no second Secret in the day.
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: secret }, new SeededRng(1)))).toBe('secret_quota_used');

    s = playTo(s, { day: 1, phase: 'NOCTHERION', turn: 1 });
    s = submit(s, 'pc-a', secret);
    expect(s.submissions['pc-a']!.visibility).toBe('secret');
    s = playTurn(s);
    expect(at(s)).toEqual({ day: 1, phase: 'NOCTHERION', turn: 2 });
    expect(rejected(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: secret }, new SeededRng(1)))).toBe('secret_quota_used');
    // Someone else's free night Secret is untouched.
    expect(submit(s, 'pc-b', secret).submissions['pc-b']!.visibility).toBe('secret');
  });

  it('the night Secret does not use the next day quota', () => {
    let s = playTo(start(), { day: 1, phase: 'NOCTHERION', turn: 1 });
    s = playTurn(submit(s, 'pc-a', secret));
    s = playTo(s, { day: 2, phase: 'EOSORIA', turn: 1 });
    expect(submit(s, 'pc-a', secret).submissions['pc-a']!.visibility).toBe('secret');
  });
});

describe('C4 no REST / SLEEP in NOCTHERION = Drowsy the next day', () => {
  function throughNight(nightActions: [PlayerAction, PlayerAction]): PhaseState {
    let s = playTo(start(), { day: 1, phase: 'NOCTHERION', turn: 1 });
    s = playTurn(submit(s, 'pc-a', nightActions[0]));
    s = playTurn(submit(s, 'pc-a', nightActions[1]));
    expect(at(s)).toEqual({ day: 2, phase: 'EOSORIA', turn: 1 });
    return s;
  }

  it('awake both NOCTHERION turns: Drowsy all next day, d20 -2 and +1 Stamina per action', () => {
    let s = throughNight([act('เฝ้ายาม'), act('เฝ้ายามต่อ')]);
    expect(s.players['pc-a']!.drowsy).toMatchObject({ day: 2 });
    expect(s.players['pc-b']!.drowsy).toBeNull();

    // d20 -2: the Drowsy status as the resolution engine reads it.
    const actor: ActorState = {
      id: 'pc-a', locationId: 'inn', hp: 100, stamina: 30, rep: 0, karma: 0, affinity: {}, items: [], skills: [],
      statuses: [], afterActionStamina: 0, damageReduction: 0,
    };
    for (const query of [{ use: 'observe' } as const, { kind: 'general', tags: ['social'], staminaCost: 3 } as const]) {
      expect(computeStat({ ...actor, statuses: [DROWSY_STATUS] }, query) - computeStat(actor, query)).toBe(-2);
    }

    // +1 Stamina on every action: the resolver settles 30 -> 27, the engine takes one more.
    s = playTurn(s, { 'pc-a': { stamina: 27 }, 'pc-b': { stamina: 27 } });
    expect(s.players['pc-a']!.stamina).toBe(26);
    expect(s.players['pc-b']!.stamina).toBe(27);

    // Still Drowsy for the rest of day 2.
    s = playTo(s, { day: 2, phase: 'NOCTHERION', turn: 2 });
    expect(s.players['pc-a']!.drowsy).toMatchObject({ day: 2 });
    s = playTurn(s, { 'pc-a': { stamina: 20 } });
    // Slept on day 2 NOCTHERION (submitAll rests): day 3 is clear.
    expect(s.players['pc-a']!.drowsy).toBeNull();
  });

  it('REST in at least one NOCTHERION turn: not Drowsy', () => {
    for (const night of [
      [sleep, act('เฝ้ายาม')],
      [act('เฝ้ายาม'), sleep],
    ] as [PlayerAction, PlayerAction][]) {
      const s = throughNight(night);
      expect(s.players['pc-a']!.drowsy).toBeNull();
      expect(playTurn(s, { 'pc-a': { stamina: 27 } }).players['pc-a']!.stamina).toBe(27);
    }
  });

  it('a rest is not charged the Drowsy Stamina', () => {
    let s = throughNight([act('เฝ้ายาม'), act('เฝ้ายามต่อ')]);
    s = playTo(s, { day: 2, phase: 'SOLARION', turn: 1 });
    s = resolve(submitAll(submit(s, 'pc-a', act('พักใต้ต้นไม้', { rest: true }))), { 'pc-a': { stamina: 10 } });
    expect(s.players['pc-a']!.stamina).toBe(18);
  });
});

describe('C5 Evil karma or a NOCTHERION Secret may sleep in EOSORIA instead (Q-087)', () => {
  function drowsyMorning(setup: { karma?: number; nightSecret?: boolean }): PhaseState {
    let s = start({ 'pc-a': { karma: setup.karma ?? 0 } });
    s = playTo(s, { day: 1, phase: 'NOCTHERION', turn: 1 });
    s = playTurn(submit(s, 'pc-a', setup.nightSecret ? secret : act('เฝ้ายาม')));
    s = playTurn(submit(s, 'pc-a', act('เฝ้ายามต่อ')));
    expect(at(s)).toEqual({ day: 2, phase: 'EOSORIA', turn: 1 });
    expect(s.players['pc-a']!.drowsy).not.toBeNull();
    return s;
  }

  for (const [name, setup] of [
    ['karma -20', { karma: -20 }],
    ['karma -14 (Evil boundary)', { karma: -14 }],
    ['a Secret in NOCTHERION that night', { nightSecret: true }],
  ] as const) {
    it(`${name}: REST in EOSORIA clears Drowsy from the next turn`, () => {
      let s = drowsyMorning(setup);
      s = playTurn(submit(s, 'pc-a', act('งีบชดเชย', { rest: true })));
      expect(at(s)).toEqual({ day: 2, phase: 'EOSORIA', turn: 2 });
      expect(s.players['pc-a']!.drowsy).toBeNull();
      expect(playTurn(s, { 'pc-a': { stamina: 20 } }).players['pc-a']!.stamina).toBe(20);
    });
  }

  for (const [name, setup] of [
    ['karma 0, no Secret', {}],
    ['karma -13 (Neutral)', { karma: -13 }],
  ] as const) {
    it(`${name}: the same EOSORIA rest leaves Drowsy for the whole day`, () => {
      let s = drowsyMorning(setup);
      s = playTurn(submit(s, 'pc-a', act('งีบชดเชย', { rest: true })));
      expect(s.players['pc-a']!.drowsy).toMatchObject({ day: 2 });
      s = playTo(s, { day: 2, phase: 'HESPERION', turn: 2 });
      expect(s.players['pc-a']!.drowsy).toMatchObject({ day: 2 });
      expect(playTurn(s, { 'pc-a': { stamina: 20 } }).players['pc-a']!.stamina).toBe(19);
    });
  }

  it('karma comes from the resolver results: turning Evil that night counts', () => {
    let s = start();
    s = playTo(s, { day: 1, phase: 'NOCTHERION', turn: 1 });
    s = playTurn(submit(s, 'pc-a', act('เฝ้ายาม')), { 'pc-a': { karma: -30 } });
    s = playTurn(submit(s, 'pc-a', act('เฝ้ายามต่อ')));
    expect(s.players['pc-a']!.drowsy).toMatchObject({ day: 2, canCompensate: true });
  });
});

describe('C6 Stamina ceiling 30', () => {
  it('28 + 5 = 30', () => {
    expect(gainStamina(28, 5)).toBe(30);
    expect(gainStamina(10, 5)).toBe(15);
  });

  it('a rest from 28 stops at 30, and a result above 30 is refused', () => {
    let s = start({ 'pc-a': { stamina: 28 } });
    s = resolve(submitAll(submit(s, 'pc-a', act('พัก', { rest: true }))));
    expect(s.players['pc-a']!.stamina).toBe(30);
    const over = phaseStep(submitAll(s), { type: 'resolved', results: { 'pc-a': { stamina: 33 } } }, new SeededRng(1));
    expect(rejected(over)).toBe('invalid_result');
  });
});

describe('C8 a game stored with the 3-phase model is converted to period + turn', () => {
  it('MORNING / AFTERNOON / NIGHT map to EOSORIA / SOLARION / HESPERION turn 1 and new player fields get defaults', () => {
    const legacy = {
      day: 5,
      phase: 'NIGHT',
      // pc-b sent and pc-a is out cold: the stored night was closed and waiting for the resolver.
      status: 'resolving',
      order: ['pc-a', 'pc-b'],
      players: {
        'pc-a': { id: 'pc-a', hp: 0, stamina: 4, condition: 'unconscious', mustSubmit: false, secretDay: 5, sleepBonus: 0,
          knockedOut: { wakeAt: { day: 6, phase: 'AFTERNOON' }, safety: 'normal', primaryAffinity: 0, rescued: false } },
        'pc-b': { id: 'pc-b', hp: 80, stamina: 12, condition: 'awake', mustSubmit: true, secretDay: null, sleepBonus: 1, knockedOut: null },
      },
      submissions: { 'pc-b': { text: 'ไปตลาด', visibility: 'public' } },
      staminaMax: 30,
      hpMax: 100,
    };
    const s = restorePhaseState(legacy);
    expect(at(s)).toEqual({ day: 5, phase: 'HESPERION', turn: 1 });
    // GEN-070: an old knock-out is out cold this turn (no wake point any more).
    expect(s.players['pc-a']!.knockedOut).toEqual({ at: { day: 5, phase: 'HESPERION', turn: 1 } });
    expect(s.players['pc-b']).toMatchObject({ stamina: 12, secretDay: null, nightSecretDay: null, drowsy: null, karma: 0 });
    expect(s.submissions['pc-b']!.text).toBe('ไปตลาด');
    // It plays on: the next turn is HESPERION turn 2.
    expect(at(playTurn(s))).toEqual({ day: 5, phase: 'HESPERION', turn: 2 });
    // A state already in the new shape comes back unchanged.
    const current = start();
    expect(restorePhaseState(JSON.parse(JSON.stringify(current)))).toEqual(current);
  });
});
