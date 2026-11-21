import type { Rng } from '../rng.ts';
import { RULES } from '../resolution/tables.ts';
import {
  GAME_DAYS,
  PHASES,
  type NewPlayer,
  type PhaseError,
  type PhaseErrorCode,
  type PhaseEvent,
  type PhaseLogEntry,
  type PhasePoint,
  type PhaseState,
  type PhaseStepResult,
  type PlayerAction,
  type PlayerPhaseState,
  type PlayerResult,
} from './types.ts';

/** Day 1 Morning, everyone awake with full HP and Stamina unless given. */
export function createPhaseState(input: { readonly players: readonly NewPlayer[] }): PhaseState {
  const players: Record<string, PlayerPhaseState> = {};
  for (const p of input.players) {
    players[p.id] = {
      id: p.id,
      hp: p.hp ?? RULES.hpMax,
      stamina: p.stamina ?? RULES.staminaMax,
      condition: 'awake',
      mustSubmit: true,
      secretDay: null,
      sleepBonus: p.sleepBonus ?? 0,
      knockedOut: null,
    };
  }
  return {
    day: 1,
    phase: 'MORNING',
    status: 'collecting',
    order: input.players.map((p) => p.id),
    players,
    submissions: {},
    staminaMax: RULES.staminaMax,
    hpMax: RULES.hpMax,
  };
}

/** Applies one event. Rejected events return an error and no new state, so the caller keeps the old one. */
export function phaseStep(state: PhaseState, event: PhaseEvent, rng: Rng): PhaseStepResult {
  switch (event.type) {
    case 'submit':
      return submit(state, event.playerId, event.action);
    case 'resolved':
      return resolved(state, event.results, rng);
  }
}

function fail(code: PhaseErrorCode, message: string): { readonly ok: false; readonly error: PhaseError } {
  return { ok: false, error: { code, message } };
}

function here(state: PhaseState): PhasePoint {
  return { day: state.day, phase: state.phase };
}

function submit(state: PhaseState, playerId: string, action: PlayerAction): PhaseStepResult {
  if (ended(state)) return fail('game_ended', `The game is over (${state.status})`);
  if (state.status !== 'collecting') return fail('not_collecting', `Phase is ${state.status}; actions are accepted only while collecting`);
  const player = state.players[playerId];
  if (!player) return fail('unknown_player', `No player "${playerId}"`);

  const replaced = playerId in state.submissions;
  const next: PhaseState = { ...state, submissions: { ...state.submissions, [playerId]: action } };
  const log: PhaseLogEntry[] = [{ type: 'submitted', at: here(state), playerId, action, replaced }];
  return { ok: true, ...closeIfComplete(next, log) };
}

/** Closes the phase once every player who must submit has; nobody else is waited for. */
function closeIfComplete(state: PhaseState, log: PhaseLogEntry[]): { state: PhaseState; log: PhaseLogEntry[] } {
  const waiting = state.order.filter((id) => state.players[id]!.mustSubmit && !(id in state.submissions));
  if (waiting.length > 0) return { state, log };
  log.push({ type: 'phase_closed', at: here(state), actions: state.submissions, asleep: [], unconscious: [] });
  return { state: { ...state, status: 'resolving' }, log };
}

function ended(state: PhaseState): boolean {
  return state.status === 'finale' || state.status === 'game_over';
}

/** The phase after `at`; null after day 12 Night. */
export function nextPoint(at: PhasePoint): PhasePoint | null {
  const index = PHASES.indexOf(at.phase);
  const phase = PHASES[index + 1];
  if (phase) return { day: at.day, phase };
  return at.day >= GAME_DAYS ? null : { day: at.day + 1, phase: PHASES[0] };
}

function checkResults(state: PhaseState, results: Readonly<Record<string, PlayerResult>>): PhaseError | null {
  for (const [id, r] of Object.entries(results)) {
    if (!state.players[id]) return { code: 'unknown_player', message: `Result for unknown player "${id}"` };
    const bad = (v: number | undefined, max: number) => v !== undefined && (!Number.isInteger(v) || v < 0 || v > max);
    if (bad(r.hp, state.hpMax)) return { code: 'invalid_result', message: `${id}.hp must be a whole number 0..${state.hpMax}` };
    if (bad(r.stamina, state.staminaMax)) return { code: 'invalid_result', message: `${id}.stamina must be a whole number 0..${state.staminaMax}` };
  }
  return null;
}

function resolved(state: PhaseState, results: Readonly<Record<string, PlayerResult>>, _rng: Rng): PhaseStepResult {
  if (ended(state)) return fail('game_ended', `The game is over (${state.status})`);
  if (state.status !== 'resolving') return fail('not_resolving', `Phase is ${state.status}; results are accepted only while resolving`);
  const error = checkResults(state, results);
  if (error) return { ok: false, error };

  const at = here(state);
  const log: PhaseLogEntry[] = [];
  const players: Record<string, PlayerPhaseState> = {};
  for (const id of state.order) {
    const p = state.players[id]!;
    const r = results[id] ?? {};
    players[id] = { ...p, hp: r.hp ?? p.hp, stamina: r.stamina ?? p.stamina };
  }

  const point = nextPoint(at);
  if (!point) {
    log.push({ type: 'finale', at });
    return { ok: true, state: { ...state, players, status: 'finale' }, log };
  }
  const next: PhaseState = { ...state, ...point, players, status: 'collecting', submissions: {} };
  log.push({ type: 'phase_started', at: point });
  return { ok: true, state: next, log };
}
