import { rollRange } from '../random.ts';
import type { Rng } from '../rng.ts';
import { RULES } from '../resolution/tables.ts';
import {
  GAME_DAYS,
  PHASES,
  type NewPlayer,
  type PlayerCondition,
  type RecoveryKind,
  type SleepReason,
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

/**
 * Sleep recovery (spec §4, §14 `rest.*`).
 * - Night rest at the inn: Stamina +rollRange(15, 25) + on_sleep bonus (GDD "พักค่ำ +15..25", GEN-052 C5;
 *   spec §4.1 still lists a fixed inn +25 and needs updating), HP +10.
 * - Night rest anywhere else: the spec's `rough` row, +15 + bonus, HP +5, until location rules (GEN-060) say more.
 * - Forced sleep in the day: +15 + bonus (spec §4.3). A day `rest` action: +8, no HP (spec §4.2).
 * Everything is capped at max.
 */
export const REST = { innMin: 15, innMax: 25, rough: 15, exhaustedDay: 15, day: 8, hpInn: 10, hpRough: 5 } as const;

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

  if (!player.mustSubmit) return fail('cannot_act', `${playerId} is ${player.condition} this phase; the input is locked`);
  if (action.restAtInn && (!action.rest || state.phase !== 'NIGHT')) {
    return fail('invalid_action', 'restAtInn needs rest: true and is only valid at Night');
  }
  if (action.visibility === 'secret' && player.secretDay === state.day) {
    return fail('secret_quota_used', `${playerId} already used today's Secret phase (one per day)`);
  }

  const replaced = playerId in state.submissions;
  const next: PhaseState = { ...state, submissions: { ...state.submissions, [playerId]: action } };
  const log: PhaseLogEntry[] = [{ type: 'submitted', at: here(state), playerId, action, replaced }];
  return { ok: true, ...closeIfComplete(next, log) };
}

/** Closes the phase once every player who must submit has; nobody else is waited for. */
function closeIfComplete(state: PhaseState, log: PhaseLogEntry[]): { state: PhaseState; log: PhaseLogEntry[] } {
  const waiting = state.order.filter((id) => state.players[id]!.mustSubmit && !(id in state.submissions));
  if (waiting.length > 0) return { state, log };
  const asleep: { playerId: string; reason: SleepReason }[] = [];
  for (const id of state.order) {
    if (state.players[id]!.condition === 'exhausted') asleep.push({ playerId: id, reason: 'exhausted' });
    else if (state.phase === 'NIGHT' && state.submissions[id]?.rest) asleep.push({ playerId: id, reason: 'night_rest' });
  }
  const unconscious = state.order.filter((id) => state.players[id]!.condition === 'unconscious');
  log.push({ type: 'phase_closed', at: here(state), actions: state.submissions, asleep, unconscious });
  // The Secret quota is used by the action that stands when the phase closes, not by a replaced draft.
  const players = mapPlayers(state, (p) => (state.submissions[p.id]?.visibility === 'secret' ? { ...p, secretDay: state.day } : p));
  return { state: { ...state, players, status: 'resolving' }, log };
}

function mapPlayers(state: PhaseState, f: (p: PlayerPhaseState) => PlayerPhaseState): Record<string, PlayerPhaseState> {
  const players: Record<string, PlayerPhaseState> = {};
  for (const id of state.order) players[id] = f(state.players[id]!);
  return players;
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

/** Which recovery a player gets at the end of this phase, if any (spec §4.1-4.3). */
function recoveryKind(state: PhaseState, p: PlayerPhaseState, r: PlayerResult): RecoveryKind | null {
  const night = state.phase === 'NIGHT';
  if (p.condition === 'exhausted') {
    if (!night) return 'exhausted_day';
    return r.atInn ? 'exhausted_night_inn' : 'exhausted_night_rough';
  }
  const action = state.submissions[p.id];
  if (p.condition !== 'awake' || !action?.rest) return null;
  if (!night) return 'day_rest';
  return action.restAtInn ? 'night_inn' : 'night_rough';
}

function recover(
  state: PhaseState,
  p: PlayerPhaseState,
  kind: RecoveryKind,
  rng: Rng,
): { player: PlayerPhaseState; entry: PhaseLogEntry } {
  let roll: number | null = null;
  let stamina: number;
  let hp = 0;
  switch (kind) {
    case 'night_inn':
    case 'exhausted_night_inn':
      roll = rollRange(REST.innMin, REST.innMax, rng);
      stamina = roll + p.sleepBonus;
      hp = REST.hpInn;
      break;
    case 'night_rough':
    case 'exhausted_night_rough':
      stamina = REST.rough + p.sleepBonus;
      hp = REST.hpRough;
      break;
    case 'exhausted_day':
      stamina = REST.exhaustedDay + p.sleepBonus;
      break;
    case 'day_rest':
      stamina = REST.day;
      break;
  }
  const staminaAfter = Math.min(state.staminaMax, p.stamina + stamina);
  const hpAfter = Math.min(state.hpMax, p.hp + hp);
  const entry: PhaseLogEntry = {
    type: 'recovered',
    at: here(state),
    playerId: p.id,
    kind,
    roll,
    stamina: { before: p.stamina, gain: staminaAfter - p.stamina, after: staminaAfter },
    hp: { before: p.hp, gain: hpAfter - p.hp, after: hpAfter },
  };
  return { player: { ...p, stamina: staminaAfter, hp: hpAfter }, entry };
}

function resolved(state: PhaseState, results: Readonly<Record<string, PlayerResult>>, rng: Rng): PhaseStepResult {
  if (ended(state)) return fail('game_ended', `The game is over (${state.status})`);
  if (state.status !== 'resolving') return fail('not_resolving', `Phase is ${state.status}; results are accepted only while resolving`);
  const error = checkResults(state, results);
  if (error) return { ok: false, error };

  const at = here(state);
  const point = nextPoint(at);
  const log: PhaseLogEntry[] = [];
  const players: Record<string, PlayerPhaseState> = {};
  // Seat order fixes the order of every die, so a replay with the same rng gives the same state.
  for (const id of state.order) {
    const before = state.players[id]!;
    const r = results[id] ?? {};
    let p: PlayerPhaseState = { ...before, hp: r.hp ?? before.hp, stamina: r.stamina ?? before.stamina };

    const kind = recoveryKind(state, before, r);
    if (kind) {
      const rec = recover(state, p, kind, rng);
      p = rec.player;
      log.push(rec.entry);
    }

    // Spec §4.3: Stamina 0 at the end of a phase = the next phase is locked and slept through.
    const exhausted = p.stamina === 0;
    if (exhausted && point) log.push({ type: 'exhausted', at, playerId: id, sleepsAt: point });
    const condition: PlayerCondition = exhausted ? 'exhausted' : 'awake';
    players[id] = { ...p, condition, mustSubmit: condition === 'awake' };
  }

  if (!point) {
    log.push({ type: 'finale', at });
    return { ok: true, state: { ...state, players, status: 'finale' }, log };
  }
  const next: PhaseState = { ...state, ...point, players, status: 'collecting', submissions: {} };
  log.push({ type: 'phase_started', at: point });
  return { ok: true, ...closeIfComplete(next, log) };
}
