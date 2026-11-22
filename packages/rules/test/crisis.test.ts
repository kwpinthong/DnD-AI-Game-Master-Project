import { describe, expect, it } from 'vitest';
import {
  CRISIS,
  ReplayRng,
  SeededRng,
  coinsAfterClinic,
  createPhaseState,
  phaseStep,
  resolvePhaseActions,
  restorePhaseState,
  type ActionOutcome,
  type CrossPlayerState,
  type PhaseAction,
  type PhaseState,
  type PhaseStepResult,
  type PlayerAction,
  type PlayerEffects,
  type PlayerResult,
  type PlayerState,
} from '../src/index.ts';
import { proposal } from './resolution-fixtures.ts';

/**
 * GEN-070 Crisis & death (System_Rules "Stamina 0 / HP 0 / Permadeath"), replacing the HP 0 / Stamina 0 rules
 * of GEN-051 / GEN-052: Stamina 0 = forced REST +6 (hits ×1.3); HP 0 = out cold one turn (STEAL / EXECUTE),
 * then carried to the clinic for 2 turns; EXECUTE while out cold = Astral Spirit for good.
 */

const IDS = ['pc-a', 'pc-b', 'pc-c'] as const;

const start = (): PhaseState => createPhaseState({ players: IDS.map((id) => ({ id, hpMax: 40 })) });
const act = (extra: Partial<PlayerAction> = {}): PlayerAction => ({ text: 'เดินดูตลาด', visibility: 'public', ...extra });

function ok(result: PhaseStepResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function submitAll(state: PhaseState): PhaseState {
  let s = state;
  for (const id of s.order) {
    if (s.status === 'collecting' && s.players[id]!.mustSubmit && !(id in s.submissions)) {
      s = ok(phaseStep(s, { type: 'submit', playerId: id, action: s.phase === 'NOCTHERION' ? act({ rest: true }) : act() }, new SeededRng(1))).state;
    }
  }
  return s;
}

function turn(state: PhaseState, results: Record<string, PlayerResult> = {}) {
  return ok(phaseStep(submitAll(state), { type: 'resolved', results }, new SeededRng(1)));
}

const condition = (s: PhaseState, id: string) => s.players[id]!.condition;

describe('C1 Stamina 0: the next turn is a forced REST (+6)', () => {
  it('locks the next turn, does not wait for them, and recovers exactly +6 (no on_sleep / Rest_Quality)', () => {
    let s = createPhaseState({ players: IDS.map((id) => ({ id, sleepBonus: id === 'pc-a' ? 3 : 0 })) });
    s = turn(s, { 'pc-a': { stamina: 0 } }).state;
    expect(condition(s, 'pc-a')).toBe('exhausted');
    expect(s.players['pc-a']!.mustSubmit).toBe(false);
    expect(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1))).toMatchObject({ ok: false, error: { code: 'cannot_act' } });

    const rested = turn(s, { 'pc-a': { restQuality: 'excellent' } });
    expect(rested.log).toContainEqual(expect.objectContaining({ type: 'recovered', playerId: 'pc-a', kind: 'exhausted', stamina: { before: 0, gain: CRISIS.exhaustedRest, after: 6 } }));
    expect(rested.state.players['pc-a']).toMatchObject({ condition: 'awake', mustSubmit: true, stamina: 6 });
  });

  it('a forced REST in NOCTHERION is +6 too', () => {
    let s: PhaseState = { ...start(), phase: 'HESPERION', turn: 2 };
    s = turn(s, { 'pc-a': { stamina: 0 } }).state;
    expect(s.phase).toBe('NOCTHERION');
    const night = turn(s, { 'pc-a': { restQuality: 'good' } });
    expect(night.state.players['pc-a']!.stamina).toBe(6);
  });

  it('every player asleep: the turn closes at once', () => {
    const s = turn(start(), { 'pc-a': { stamina: 0 }, 'pc-b': { stamina: 0 }, 'pc-c': { stamina: 0 } }).state;
    expect(s.status).toBe('resolving');
  });
});

describe('C2 HP 0: out cold for one turn, locked, the turn does not wait', () => {
  it('locks only the next turn; the others close it', () => {
    const ko = turn(start(), { 'pc-a': { hp: 0 } });
    expect(ko.log).toContainEqual(expect.objectContaining({ type: 'knocked_out', playerId: 'pc-a' }));
    let s = ko.state;
    expect(s.players['pc-a']).toMatchObject({ condition: 'unconscious', mustSubmit: false, hp: 0 });
    expect(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1))).toMatchObject({ ok: false, error: { code: 'cannot_act' } });
    s = submitAll(s);
    expect(s.status).toBe('resolving');
  });

  it('an exhausted player hit to 0 is out cold the same way', () => {
    let s = turn(start(), { 'pc-a': { stamina: 0 } }).state;
    s = turn(s, { 'pc-a': { hp: 0 } }).state;
    expect(condition(s, 'pc-a')).toBe('unconscious');
  });
});

describe('C3 not executed: carried to the central clinic, 2 turns of rest, half the coins', () => {
  it('after the turn out cold: recovering 2 turns (locked), then awake at full Max HP', () => {
    let s = turn(start(), { 'pc-a': { hp: 0 } }).state;
    const carried = turn(s);
    expect(carried.log).toContainEqual(expect.objectContaining({ type: 'carried_to_clinic', playerId: 'pc-a' }));
    s = carried.state;
    expect(s.players['pc-a']).toMatchObject({ condition: 'recovering', mustSubmit: false });
    expect(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1))).toMatchObject({ ok: false, error: { code: 'cannot_act' } });

    s = turn(s).state;
    expect(condition(s, 'pc-a')).toBe('recovering');
    // The clinic protects: a result that hurts a recovering player is not applied.
    const released = turn(s, { 'pc-a': { hp: 0, stamina: 0 } });
    expect(released.log).toContainEqual(expect.objectContaining({ type: 'clinic_released', playerId: 'pc-a' }));
    expect(released.state.players['pc-a']).toMatchObject({ condition: 'awake', mustSubmit: true, hp: 40 });
    expect(released.state.players['pc-a']!.stamina).toBeGreaterThan(0);
  });

  it('coins: 25 -> 12 (rounded down), 0 stays 0', () => {
    expect(CRISIS.clinicTurns).toBe(2);
    expect(coinsAfterClinic(25)).toBe(12);
    expect(coinsAfterClinic(1)).toBe(0);
    expect(coinsAfterClinic(0)).toBe(0);
  });
});

describe('C4 EXECUTE while out cold: Astral Spirit for good', () => {
  it('becomes an Astral Spirit, never acts again, and is not waited for', () => {
    let s = turn(start(), { 'pc-a': { hp: 0 } }).state;
    const died = turn(s, { 'pc-a': { executed: true } });
    expect(died.log).toContainEqual(expect.objectContaining({ type: 'died', playerId: 'pc-a' }));
    s = died.state;
    expect(s.players['pc-a']).toMatchObject({ condition: 'astral_spirit', mustSubmit: false, diedAt: { day: 1, phase: 'EOSORIA', turn: 2 } });
    for (let i = 0; i < 6; i++) s = turn(s).state;
    expect(s.players['pc-a']).toMatchObject({ condition: 'astral_spirit', mustSubmit: false });
    expect(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1))).toMatchObject({ ok: false, error: { code: 'cannot_act' } });
  });

  it('executed is refused for a player who is not out cold', () => {
    const result = phaseStep(submitAll(start()), { type: 'resolved', results: { 'pc-a': { executed: true } } }, new SeededRng(1));
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_result' } });
  });
});

describe('C7 every player dead for good: game over', () => {
  it('the last one executed ends the game', () => {
    let s = turn(start(), { 'pc-a': { hp: 0 }, 'pc-b': { hp: 0 } }).state;
    s = turn(s, { 'pc-a': { executed: true }, 'pc-b': { executed: true } }).state;
    expect(s.status).not.toBe('game_over');
    s = turn(s, { 'pc-c': { hp: 0 } }).state;
    const end = turn(s, { 'pc-c': { executed: true } });
    expect(end.state.status).toBe('game_over');
    expect(end.log).toContainEqual(expect.objectContaining({ type: 'game_over', reason: 'all_dead' }));
  });

  it('everyone out cold at once is not a game over (they are carried to the clinic)', () => {
    let s = turn(start(), { 'pc-a': { hp: 0 }, 'pc-b': { hp: 0 }, 'pc-c': { hp: 0 } }).state;
    for (let guard = 0; guard < 6 && s.status === 'resolving'; guard++) s = ok(phaseStep(s, { type: 'resolved', results: {} }, new SeededRng(1))).state;
    expect(s.status).toBe('collecting');
    expect(IDS.every((id) => condition(s, id) === 'awake')).toBe(true);
  });
});

describe('a state stored before GEN-070 reads on', () => {
  it('an old knock-out (wakeAt, rescue roll fields) is out cold this turn', () => {
    const old = {
      ...start(),
      players: {
        ...start().players,
        'pc-a': { ...start().players['pc-a']!, hp: 0, condition: 'unconscious', mustSubmit: false, knockedOut: { wakeAt: { day: 2, phase: 'EOSORIA', turn: 1 }, safety: 'normal', primaryAffinity: 0, rescued: false } },
      },
    };
    const s = restorePhaseState(JSON.parse(JSON.stringify(old)));
    expect(condition(s, 'pc-a')).toBe('unconscious');
    expect(condition(turn(s).state, 'pc-a')).toBe('recovering');
  });
});

// --- Cross-player: ×1.3 on an exhausted target, EXECUTE, the clinic protects ---

const none: PlayerEffects = { damage: null, heal: null, takeItem: null, giveItem: null };

function pc(id: string, seat: number, patch: Partial<PlayerState> = {}): PlayerState {
  return { id, seat, locationId: 'market', hp: 40, stamina: 30, rep: 0, karma: 0, affinity: {}, items: [], skills: [], statuses: [], afterActionStamina: 0, damageReduction: 0, remoteReach: [], ...patch };
}

const world = (...players: PlayerState[]): CrossPlayerState => ({ players: Object.fromEntries(players.map((p) => [p.id, p])), npcs: {} });

function aimed(intent: 'harm' | 'execute' | 'steal', onSuccess: PlayerEffects = none): PhaseAction {
  return {
    actorId: 'pc-a',
    proposal: proposal({ actionId: 'act-a', kind: 'exertion', staminaCost: 8, tags: ['physical'], check: { type: 'none' }, modifiers: [] }),
    targetPlayer: { player: 'pc-b', intent, reachRef: null, defenseRef: null, perceptionRef: null, onSuccess, onFail: none },
    moveTo: null,
    awareness: 'normal',
  };
}

function targetOf(outcomes: readonly ActionOutcome[]) {
  const o = outcomes.find((x) => x.actorId === 'pc-a');
  if (o?.status !== 'resolved' || o.target === null) throw new Error(`no resolved target: ${JSON.stringify(o)}`);
  return o.target;
}

describe('C1 an exhausted target takes ×1.3 (rounded toward zero, GEN-042)', () => {
  it('a hit of 10 HP (moderate 15 - 5 reduction) takes 13', () => {
    const hit = aimed('harm', { ...none, damage: 'moderate' });
    const rested = resolvePhaseActions({ state: world(pc('pc-a', 0), pc('pc-b', 1, { damageReduction: 5 })), actions: [hit] }, new ReplayRng([10]));
    if (!rested.ok) throw new Error(JSON.stringify(rested.errors));
    expect(targetOf(rested.log.outcomes).hp.damage).toBe(10);

    const tired = resolvePhaseActions({ state: world(pc('pc-a', 0), pc('pc-b', 1, { damageReduction: 5, crisis: 'exhausted' })), actions: [hit] }, new ReplayRng([10]));
    if (!tired.ok) throw new Error(JSON.stringify(tired.errors));
    expect(targetOf(tired.log.outcomes).hp).toMatchObject({ damage: 13, after: 27 });
  });

  it('a light hit of 8 takes 10 (10.4 rounded toward zero)', () => {
    const tired = resolvePhaseActions({ state: world(pc('pc-a', 0), pc('pc-b', 1, { crisis: 'exhausted' })), actions: [aimed('harm', { ...none, damage: 'light' })] }, new ReplayRng([10]));
    if (!tired.ok) throw new Error(JSON.stringify(tired.errors));
    expect(targetOf(tired.log.outcomes).hp.damage).toBe(10);
  });
});

describe('C4 EXECUTE in the cross-player rules', () => {
  it('a successful EXECUTE on a player out cold marks them executed', () => {
    const r = resolvePhaseActions({ state: world(pc('pc-a', 0), pc('pc-b', 1, { hp: 0 })), actions: [aimed('execute')] }, new ReplayRng([10]));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(targetOf(r.log.outcomes).executed).toBe(true);
  });

  it('EXECUTE needs the target out cold; nobody may target a player recovering at the clinic', () => {
    const awake = resolvePhaseActions({ state: world(pc('pc-a', 0), pc('pc-b', 1)), actions: [aimed('execute')] }, new SeededRng(1));
    expect(awake.ok).toBe(false);
    if (!awake.ok) expect(awake.errors.map((e) => e.code)).toEqual(['execute_needs_unconscious']);

    for (const intent of ['harm', 'steal', 'execute'] as const) {
      const clinic = resolvePhaseActions({ state: world(pc('pc-a', 0), pc('pc-b', 1, { hp: 0, crisis: 'recovering' })), actions: [aimed(intent)] }, new SeededRng(1));
      expect(clinic.ok, intent).toBe(false);
      if (!clinic.ok) expect(clinic.errors.map((e) => e.code)).toContain('target_recovering');
    }
  });
});
