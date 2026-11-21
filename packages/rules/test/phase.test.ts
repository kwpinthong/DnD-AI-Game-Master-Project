import { describe, expect, it } from 'vitest';
import {
  SeededRng,
  createPhaseState,
  phaseStep,
  type PhaseEvent,
  type PhaseState,
  type PhaseStepResult,
  type PlayerAction,
  type PlayerResult,
} from '../src/index.ts';

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

/** Every player who must submit and has not yet sends an action. */
function submitAll(state: PhaseState, action: PlayerAction = act()): PhaseState {
  let s = state;
  for (const id of s.order) {
    if (s.status === 'collecting' && s.players[id]!.mustSubmit && !(id in s.submissions)) s = submit(s, id, action);
  }
  return s;
}

function resolve(state: PhaseState, results: Record<string, PlayerResult> = {}, seed = 1): PhaseState {
  return step(state, { type: 'resolved', results }, seed);
}

/** Submit for everyone who must, then resolve with the given results. */
function playPhase(state: PhaseState, results: Record<string, PlayerResult> = {}, action: PlayerAction = act(), seed = 1): PhaseState {
  return resolve(submitAll(state, action), results, seed);
}

describe('C1 phase closes when every player who can act has submitted', () => {
  it('2 of 3 submitted: still collecting; 3 of 3: closed, then the next phase after resolve', () => {
    let s = start();
    s = submit(s, 'pc-a');
    s = submit(s, 'pc-b');
    expect(s.status).toBe('collecting');
    expect(s.phase).toBe('MORNING');

    const closed = ok(phaseStep(s, { type: 'submit', playerId: 'pc-c', action: act() }, new SeededRng(1)));
    expect(closed.state.status).toBe('resolving');
    expect(closed.log.some((e) => e.type === 'phase_closed')).toBe(true);

    const next = resolve(closed.state);
    expect(next.status).toBe('collecting');
    expect(next.day).toBe(1);
    expect(next.phase).toBe('AFTERNOON');
    expect(next.submissions).toEqual({});
  });
});

/** Plays whole phases until the state reaches the given point. */
function playTo(state: PhaseState, day: number, phase: PhaseState['phase']): PhaseState {
  let s = state;
  for (let guard = 0; guard < 100 && !(s.day === day && s.phase === phase); guard++) s = playPhase(s);
  return s;
}

describe('C2 after Night comes the next Morning, and Stamina is not reset', () => {
  it('day 1 Night -> day 2 Morning with Stamina carried over', () => {
    let s = playTo(start(), 1, 'NIGHT');
    s = submitAll(s, act('สืบเรื่องลัทธิ'));
    s = resolve(s, { 'pc-a': { stamina: 12 }, 'pc-b': { stamina: 7 }, 'pc-c': { stamina: 30 } });
    expect(s.day).toBe(2);
    expect(s.phase).toBe('MORNING');
    expect(s.status).toBe('collecting');
    expect(s.players['pc-a']!.stamina).toBe(12);
    expect(s.players['pc-b']!.stamina).toBe(7);
    expect(s.players['pc-c']!.stamina).toBe(30);
  });
});

describe('C8 the end of day 12 Night is the finale; there is no day 13', () => {
  it('enters finale and rejects any further action', () => {
    let s = playTo(start(), 12, 'NIGHT');
    expect(s.status).toBe('collecting');
    const end = ok(phaseStep(submitAll(s), { type: 'resolved', results: {} }, new SeededRng(1)));
    expect(end.state.status).toBe('finale');
    expect(end.state.day).toBe(12);
    expect(end.state.phase).toBe('NIGHT');
    expect(end.log).toContainEqual(expect.objectContaining({ type: 'finale' }));
    expect(rejected(phaseStep(end.state, { type: 'submit', playerId: 'pc-a', action: act() }, new SeededRng(1)))).toBe('game_ended');
    expect(rejected(phaseStep(end.state, { type: 'resolved', results: {} }, new SeededRng(1)))).toBe('game_ended');
  });
});

describe('C3 one Secret phase per day', () => {
  const secret = act('แอบขโมยกุญแจ', { visibility: 'secret' });

  it('a Secret in the Morning blocks a Secret in the Afternoon; the next day it is allowed again', () => {
    let s = start();
    s = submit(s, 'pc-a', secret);
    s = resolve(submitAll(s));
    expect(s.phase).toBe('AFTERNOON');

    const again = phaseStep(s, { type: 'submit', playerId: 'pc-a', action: secret }, new SeededRng(1));
    expect(rejected(again)).toBe('secret_quota_used');
    // Other players and Public actions are not affected.
    s = submit(s, 'pc-b', secret);
    s = submit(s, 'pc-a', act());

    s = playTo(s, 2, 'MORNING');
    expect(submit(s, 'pc-a', secret).submissions['pc-a']!.visibility).toBe('secret');
  });

  it('a Secret replaced by a Public action before the phase closes does not use the quota', () => {
    let s = start();
    s = submit(s, 'pc-a', secret);
    s = submit(s, 'pc-a', act());
    s = resolve(submitAll(s));
    expect(submit(s, 'pc-a', secret).submissions['pc-a']!.visibility).toBe('secret');
  });
});

describe('C7 resubmitting before the phase closes replaces the action; during resolve it is rejected', () => {
  it('replaces the earlier action', () => {
    let s = start();
    s = submit(s, 'pc-a', act('ไปวิหาร'));
    const replaced = ok(phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act('ไปตลาด') }, new SeededRng(1)));
    expect(replaced.state.submissions['pc-a']!.text).toBe('ไปตลาด');
    expect(Object.keys(replaced.state.submissions)).toEqual(['pc-a']);
    expect(replaced.log).toContainEqual(expect.objectContaining({ type: 'submitted', playerId: 'pc-a', replaced: true }));
  });

  it('rejects a submit while the phase is resolving and keeps the state', () => {
    const s = submitAll(start());
    expect(s.status).toBe('resolving');
    const result = phaseStep(s, { type: 'submit', playerId: 'pc-a', action: act('เปลี่ยนใจ') }, new SeededRng(1));
    expect(rejected(result)).toBe('not_collecting');
    expect(s.submissions['pc-a']!.text).toBe('เดินดูตลาด');
  });
});
