import type { Rng } from '../rng.ts';
import { RULES } from '../resolution/tables.ts';
import {
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

function resolved(state: PhaseState, _results: Readonly<Record<string, PlayerResult>>, _rng: Rng): PhaseStepResult {
  if (state.status !== 'resolving') return fail('not_resolving', `Phase is ${state.status}; results are accepted only while resolving`);
  const index = PHASES.indexOf(state.phase);
  const nextPhase = PHASES[index + 1];
  if (!nextPhase) throw new Error('not implemented');
  const next: PhaseState = { ...state, phase: nextPhase, status: 'collecting', submissions: {} };
  return { ok: true, state: next, log: [{ type: 'phase_started', at: here(next) }] };
}
