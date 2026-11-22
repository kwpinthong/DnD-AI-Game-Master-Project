import type { Rng } from '../rng.ts';
import { rollRescue, wakeAfter, type RescueOutcome } from '../resolution/rescue.ts';
import { RULES } from '../resolution/tables.ts';
import {
  DROWSY,
  EVIL_KARMA_MAX,
  GAME_DAYS,
  LEGACY_PHASES,
  NIGHT_PERIOD,
  PERIODS,
  TURNS_PER_PERIOD,
  type Drowsy,
  type KnockedOut,
  type NewPlayer,
  type Period,
  type PlayerCondition,
  type RecoveryKind,
  type RestQuality,
  type SleepReason,
  type PhaseError,
  type PhaseErrorCode,
  type PhaseEvent,
  type PhaseLogEntry,
  type PhaseState,
  type PhaseStepResult,
  type PlayerAction,
  type PlayerPhaseState,
  type PlayerResult,
  type TurnPoint,
} from './types.ts';

/**
 * Sleep recovery per turn (spec §4, §14 `rest.*`).
 * - NOCTHERION sleep (REST or forced): Stamina by the place's Rest_Quality (Q-218, `REST_QUALITY_STAMINA`;
 *   absent = poor) + on_sleep bonus, HP +5 (+10 at the paid inn, +15 at the infirmary).
 * - Forced sleep outside NOCTHERION: +15 + bonus (spec §4.3). A `rest` action outside NOCTHERION: +8, no HP
 *   (spec §4.2); +10 at the paid inn, HP +15 at the infirmary (GEN-069 Location Special_Mechanics).
 * - Infirmary, both turns of one period: HP back to Max HP.
 * - The server's `restBonus` (Q-209 start passives) on top of any of these.
 * Everything is capped at max (System_Rules: Stamina ceiling 30 for the whole game).
 */
export const REST = { exhaustedDay: 15, day: 8, innDay: 10, hpNight: 5, hpInnNight: 10, hpClinic: 15 } as const;

/** Q-218 (Nok's values): night Stamina by Rest_Quality. */
export const REST_QUALITY_STAMINA: Readonly<Record<RestQuality, number>> = { poor: 15, normal: 20, good: 25, excellent: 30 };

/** GEN-069 TRAIN at the guild (Q-088): Max HP +3, once a day, never above 45. */
export const TRAIN = { hpMax: 3, hpMaxCap: 45 } as const;

/** A player's own Max HP (GEN-065 / Q-210), else the state's (100 in older saved states). */
export function playerHpMax(state: Pick<PhaseState, 'hpMax'>, p: Pick<PlayerPhaseState, 'hpMax'>): number {
  return p.hpMax ?? state.hpMax;
}

/** Stamina after a gain, never above the ceiling (C6: 28 + 5 = 30). */
export function gainStamina(current: number, gain: number, max: number = RULES.staminaMax): number {
  return Math.min(max, current + gain);
}

/** Day 1 EOSORIA turn 1, everyone awake with full HP and Stamina unless given. */
export function createPhaseState(input: { readonly players: readonly NewPlayer[] }): PhaseState {
  const players: Record<string, PlayerPhaseState> = {};
  for (const p of input.players) players[p.id] = newPlayer(p);
  return {
    day: 1,
    phase: PERIODS[0],
    turn: 1,
    status: 'collecting',
    order: input.players.map((p) => p.id),
    players,
    submissions: {},
    staminaMax: RULES.staminaMax,
    hpMax: RULES.hpMax,
  };
}

function newPlayer(p: NewPlayer): PlayerPhaseState {
  return {
    id: p.id,
    hp: p.hp ?? p.hpMax ?? RULES.hpMax,
    ...(p.hpMax !== undefined ? { hpMax: p.hpMax } : {}),
    stamina: p.stamina ?? RULES.staminaMax,
    condition: 'awake',
    mustSubmit: true,
    secretDay: null,
    nightSecretDay: null,
    sleptDay: null,
    drowsy: null,
    karma: p.karma ?? 0,
    sleepBonus: p.sleepBonus ?? 0,
    knockedOut: null,
  };
}

/** 1..96: where `at` is in the game. */
export function turnNumber(at: TurnPoint): number {
  return ((at.day - 1) * PERIODS.length + PERIODS.indexOf(at.phase)) * TURNS_PER_PERIOD + at.turn;
}

/** The turn after `at`; null after day 12 NOCTHERION turn 2 (the finale). */
export function nextPoint(at: TurnPoint): TurnPoint | null {
  if (at.turn < TURNS_PER_PERIOD) return { day: at.day, phase: at.phase, turn: 2 };
  const phase = PERIODS[PERIODS.indexOf(at.phase) + 1];
  if (phase) return { day: at.day, phase, turn: 1 };
  return at.day >= GAME_DAYS ? null : { day: at.day + 1, phase: PERIODS[0], turn: 1 };
}

export function isDrowsy(player: PlayerPhaseState, day: number): boolean {
  return player.drowsy !== null && player.drowsy.day === day;
}

/** Whether the Secret quota that applies at `at` is used: tonight's free one in NOCTHERION, else today's. */
export function secretQuotaUsed(player: PlayerPhaseState, at: Pick<TurnPoint, 'day' | 'phase'>): boolean {
  return (at.phase === NIGHT_PERIOD ? player.nightSecretDay : player.secretDay) === at.day;
}

/**
 * Reads a stored state, including one saved by the 3-phase engine of GEN-052 (C8): MORNING / AFTERNOON /
 * NIGHT become EOSORIA / SOLARION / HESPERION turn 1 (`LEGACY_PHASES`), and fields added since get their
 * starting value. A state already in the current shape comes back equal.
 */
export function restorePhaseState(raw: unknown): PhaseState {
  const s = raw as PhaseState & { phase: string; turn?: number };
  const point = (p: { day: number; phase: string; turn?: number }): TurnPoint => ({
    day: p.day,
    phase: (LEGACY_PHASES as Record<string, Period>)[p.phase] ?? (p.phase as Period),
    turn: p.turn === 2 ? 2 : 1,
  });
  const players: Record<string, PlayerPhaseState> = {};
  for (const id of s.order) {
    const p = s.players[id]! as Partial<PlayerPhaseState> & Pick<PlayerPhaseState, 'id' | 'hp' | 'stamina'>;
    const ko = p.knockedOut ?? null;
    players[id] = {
      ...newPlayer({ id: p.id }),
      ...p,
      nightSecretDay: p.nightSecretDay ?? null,
      sleptDay: p.sleptDay ?? null,
      drowsy: p.drowsy ?? null,
      karma: p.karma ?? 0,
      knockedOut: ko ? { ...ko, wakeAt: point(ko.wakeAt) } : null,
    } as PlayerPhaseState;
  }
  return { ...s, ...point(s), players };
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

function here(state: PhaseState): TurnPoint {
  return { day: state.day, phase: state.phase, turn: state.turn };
}

const isNight = (state: PhaseState) => state.phase === NIGHT_PERIOD;

function submit(state: PhaseState, playerId: string, action: PlayerAction): PhaseStepResult {
  if (ended(state)) return fail('game_ended', `The game is over (${state.status})`);
  if (state.status !== 'collecting') return fail('not_collecting', `Turn is ${state.status}; actions are accepted only while collecting`);
  const player = state.players[playerId];
  if (!player) return fail('unknown_player', `No player "${playerId}"`);

  if (!player.mustSubmit) return fail('cannot_act', `${playerId} is ${player.condition} this turn; the input is locked`);
  if (action.train) {
    if (action.rest) return fail('invalid_action', 'TRAIN and REST are two different actions');
    if (player.trainedDay === state.day) return fail('train_used', `${playerId} already trained today (once a day)`);
    if (playerHpMax(state, player) >= TRAIN.hpMaxCap) return fail('train_cap', `${playerId} is at the TRAIN ceiling (Max HP ${TRAIN.hpMaxCap})`);
  }
  if (action.visibility === 'secret' && secretQuotaUsed(player, state)) {
    return fail(
      'secret_quota_used',
      isNight(state)
        ? `${playerId} already used tonight's free ${NIGHT_PERIOD} Secret turn`
        : `${playerId} already used today's Secret turn (one per day, plus one in ${NIGHT_PERIOD})`,
    );
  }

  const replaced = playerId in state.submissions;
  const next: PhaseState = { ...state, submissions: { ...state.submissions, [playerId]: action } };
  const log: PhaseLogEntry[] = [{ type: 'submitted', at: here(state), playerId, action, replaced }];
  return { ok: true, ...closeIfComplete(next, log) };
}

/** Closes the turn once every player who must submit has; nobody else is waited for. */
function closeIfComplete(state: PhaseState, log: PhaseLogEntry[]): { state: PhaseState; log: PhaseLogEntry[] } {
  const waiting = state.order.filter((id) => state.players[id]!.mustSubmit && !(id in state.submissions));
  if (waiting.length > 0) return { state, log };
  const asleep: { playerId: string; reason: SleepReason }[] = [];
  for (const id of state.order) {
    if (state.players[id]!.condition === 'exhausted') asleep.push({ playerId: id, reason: 'exhausted' });
    else if (isNight(state) && state.submissions[id]?.rest) asleep.push({ playerId: id, reason: 'night_rest' });
  }
  const unconscious = state.order.filter((id) => state.players[id]!.condition === 'unconscious');
  log.push({ type: 'phase_closed', at: here(state), actions: state.submissions, asleep, unconscious });
  // The Secret quota is used by the action that stands when the turn closes, not by a replaced draft.
  const players = mapPlayers(state, (p) => {
    if (state.submissions[p.id]?.visibility !== 'secret') return p;
    return isNight(state) ? { ...p, nightSecretDay: state.day } : { ...p, secretDay: state.day };
  });
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

function checkResults(state: PhaseState, results: Readonly<Record<string, PlayerResult>>): PhaseError | null {
  for (const [id, r] of Object.entries(results)) {
    if (!state.players[id]) return { code: 'unknown_player', message: `Result for unknown player "${id}"` };
    const bad = (v: number | undefined, min: number, max: number) => v !== undefined && (!Number.isInteger(v) || v < min || v > max);
    const hpMax = playerHpMax(state, state.players[id]!);
    if (bad(r.hp, 0, hpMax)) return { code: 'invalid_result', message: `${id}.hp must be a whole number 0..${hpMax}` };
    if (bad(r.stamina, 0, state.staminaMax)) return { code: 'invalid_result', message: `${id}.stamina must be a whole number 0..${state.staminaMax}` };
    if (bad(r.restBonus?.stamina, 0, state.staminaMax) || bad(r.restBonus?.hp, 0, hpMax)) {
      return { code: 'invalid_result', message: `${id}.restBonus must be whole numbers >= 0` };
    }
    if (bad(r.karma, RULES.rangeMin, RULES.rangeMax)) {
      return { code: 'invalid_result', message: `${id}.karma must be a whole number ${RULES.rangeMin}..${RULES.rangeMax}` };
    }
  }
  return null;
}

/** Which recovery a player gets at the end of this turn, if any (spec §4.1-4.3). */
function recoveryKind(state: PhaseState, p: PlayerPhaseState): RecoveryKind | null {
  const night = isNight(state);
  if (p.condition === 'exhausted') return night ? 'exhausted_night' : 'exhausted_day';
  const action = state.submissions[p.id];
  if (p.condition !== 'awake' || !action?.rest) return null;
  return night ? 'night_rest' : 'day_rest';
}

/** Infirmary turn 2 right after an infirmary turn 1 of the same period (GEN-069 C2). */
function clinicSecondTurn(state: PhaseState, p: PlayerPhaseState): boolean {
  const last = p.clinicRestAt;
  return state.turn === 2 && last !== undefined && last.day === state.day && last.phase === state.phase && last.turn === 1;
}

function recover(state: PhaseState, p: PlayerPhaseState, kind: RecoveryKind, r: PlayerResult): { player: PlayerPhaseState; entry: PhaseLogEntry } {
  const quality: RestQuality = r.restQuality ?? 'poor';
  // Special mechanics are for a REST action; a forced sleep only takes the place's quality.
  const site = kind === 'night_rest' || kind === 'day_rest' ? (r.restSite ?? null) : null;
  let stamina: number;
  let hp = 0;
  switch (kind) {
    case 'night_rest':
    case 'exhausted_night':
      stamina = REST_QUALITY_STAMINA[quality] + p.sleepBonus;
      hp = site === 'inn' ? REST.hpInnNight : REST.hpNight;
      break;
    case 'exhausted_day':
      stamina = REST.exhaustedDay + p.sleepBonus;
      break;
    case 'day_rest':
      stamina = site === 'inn' ? REST.innDay : REST.day;
      break;
  }
  if (site === 'clinic') hp = REST.hpClinic;
  stamina += r.restBonus?.stamina ?? 0;
  hp += r.restBonus?.hp ?? 0;
  const hpMax = playerHpMax(state, p);
  const staminaAfter = gainStamina(p.stamina, stamina, state.staminaMax);
  const hpAfter = site === 'clinic' && clinicSecondTurn(state, p) ? hpMax : Math.min(hpMax, p.hp + hp);
  const entry: PhaseLogEntry = {
    type: 'recovered',
    at: here(state),
    playerId: p.id,
    kind,
    site,
    stamina: { before: p.stamina, gain: staminaAfter - p.stamina, after: staminaAfter },
    hp: { before: p.hp, gain: hpAfter - p.hp, after: hpAfter },
  };
  const next: PlayerPhaseState = { ...p, stamina: staminaAfter, hp: hpAfter, ...(site === 'clinic' ? { clinicRestAt: here(state) } : {}) };
  return { player: next, entry };
}

/** GEN-069 C3: a TRAIN that stood raises Max HP (HP unchanged), capped at TRAIN.hpMaxCap. */
function applyTrain(state: PhaseState, p: PlayerPhaseState, log: PhaseLogEntry[]): PlayerPhaseState {
  const before = playerHpMax(state, p);
  const after = Math.min(TRAIN.hpMaxCap, before + TRAIN.hpMax);
  log.push({ type: 'trained', at: here(state), playerId: p.id, hpMax: { before, after } });
  return { ...p, hpMax: after, trainedDay: state.day };
}

function samePoint(a: TurnPoint, b: TurnPoint): boolean {
  return a.day === b.day && a.phase === b.phase && a.turn === b.turn;
}

/** Spec §12.2: wake at the start of the next day's EOSORIA, or the next day's SOLARION after a NOCTHERION knock-out. */
function knockOutWake(at: TurnPoint): TurnPoint {
  return { day: at.day + 1, phase: at.phase === NIGHT_PERIOD ? 'SOLARION' : 'EOSORIA', turn: 1 };
}

/**
 * Game over (C6 read with Q-057, no death): every player is unconscious and none wakes before the game ends,
 * i.e. every wake point is after day 12. Exhausted players always wake next turn, so they never count.
 */
function isGameOver(order: readonly string[], players: Readonly<Record<string, PlayerPhaseState>>): boolean {
  return order.every((id) => {
    const p = players[id]!;
    return p.condition === 'unconscious' && p.knockedOut !== null && p.knockedOut.wakeAt.day > GAME_DAYS;
  });
}

function wake(p: PlayerPhaseState, ko: KnockedOut, rng: Rng): { player: PlayerPhaseState; entry: Omit<Extract<PhaseLogEntry, { type: 'woke' }>, 'at'> } {
  let outcome: RescueOutcome = 'rescued';
  let rescueRoll: { d20: number; score: number } | null = null;
  if (!ko.rescued) {
    const roll = rollRescue({ safety: ko.safety, primaryAffinity: ko.primaryAffinity }, rng);
    outcome = roll.outcome;
    rescueRoll = { d20: roll.d20, score: roll.score };
  }
  const after = wakeAfter(outcome, p.stamina);
  return {
    player: { ...p, hp: after.hp, stamina: after.stamina, condition: 'awake', mustSubmit: true, knockedOut: null },
    entry: { type: 'woke', playerId: p.id, outcome, rescueRoll, hp: after.hp, stamina: after.stamina },
  };
}

/**
 * The time rules that run at the end of every turn (System_Rules "ช่วง NOCTHERION & ภาวะอดนอน", Q-087), on
 * the player as they were when the turn closed (`before`) and as the turn left them (`p`):
 * - an action (not a rest) while Drowsy costs DROWSY.stamina more;
 * - sleeping (REST, forced sleep, out cold) in NOCTHERION marks the night slept;
 * - a make-up rest in EOSORIA clears Drowsy for a player who may make up (Evil, or a NOCTHERION Secret).
 */
function timeRules(state: PhaseState, before: PlayerPhaseState, p: PlayerPhaseState, at: TurnPoint, log: PhaseLogEntry[]): PlayerPhaseState {
  const action = state.submissions[before.id];
  const slept = before.condition !== 'awake' || action?.rest === true;
  let next = p;
  if (before.condition === 'awake' && action && !action.rest && isDrowsy(before, state.day)) {
    const after = Math.max(0, next.stamina - DROWSY.stamina);
    log.push({ type: 'drowsy_cost', at, playerId: before.id, stamina: { before: next.stamina, after } });
    next = { ...next, stamina: after };
  }
  if (isNight(state) && (slept || next.condition === 'unconscious')) next = { ...next, sleptDay: state.day };
  if (state.phase === PERIODS[0] && slept && isDrowsy(before, state.day) && before.drowsy!.canCompensate) {
    log.push({ type: 'drowsy_cleared', at, playerId: before.id });
    next = { ...next, drowsy: null };
  }
  return next;
}

/** At the change of day: who stayed awake through last night's NOCTHERION is Drowsy for the new day. */
function startDay(day: number, p: PlayerPhaseState, at: TurnPoint, log: PhaseLogEntry[]): PlayerPhaseState {
  const night = day - 1;
  if (p.sleptDay === night) return { ...p, drowsy: null };
  const drowsy: Drowsy = { day, canCompensate: p.karma <= EVIL_KARMA_MAX || p.nightSecretDay === night };
  log.push({ type: 'drowsy', at, playerId: p.id, drowsy });
  return { ...p, drowsy };
}

function resolved(state: PhaseState, results: Readonly<Record<string, PlayerResult>>, rng: Rng): PhaseStepResult {
  if (ended(state)) return fail('game_ended', `The game is over (${state.status})`);
  if (state.status !== 'resolving') return fail('not_resolving', `Turn is ${state.status}; results are accepted only while resolving`);
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
    let p: PlayerPhaseState = { ...before, hp: r.hp ?? before.hp, stamina: r.stamina ?? before.stamina, karma: r.karma ?? before.karma };

    if (before.condition === 'unconscious') {
      // Damage to an unconscious character is 0 (spec §12.2), so only a rescue changes anything.
      p = { ...before, karma: p.karma };
      if (r.rescued && before.knockedOut && !before.knockedOut.rescued) {
        p = { ...p, knockedOut: { ...before.knockedOut, rescued: true } };
        log.push({ type: 'rescued_by_player', at, playerId: id });
      }
      players[id] = timeRules(state, before, p, at, log);
      continue;
    }

    if (p.hp === 0) {
      // Q-054: lost for the rest of the day; a NOCTHERION knock-out still loses the next EOSORIA. No rest recovery.
      const wakeAt = knockOutWake(at);
      const knockedOut: KnockedOut = { wakeAt, safety: r.safety ?? 'normal', primaryAffinity: r.primaryAffinity ?? 0, rescued: false };
      log.push({ type: 'knocked_out', at, playerId: id, wakeAt });
      players[id] = timeRules(state, before, { ...p, condition: 'unconscious', mustSubmit: false, knockedOut }, at, log);
      continue;
    }

    const kind = recoveryKind(state, before);
    if (kind) {
      const rec = recover(state, p, kind, r);
      p = rec.player;
      log.push(rec.entry);
    }
    if (before.condition === 'awake' && state.submissions[id]?.train) p = applyTrain(state, p, log);
    p = timeRules(state, before, p, at, log);

    // Spec §4.3: Stamina 0 at the end of a turn = the next turn is locked and slept through.
    const exhausted = p.stamina === 0;
    if (exhausted && point) log.push({ type: 'exhausted', at, playerId: id, sleepsAt: point });
    const condition: PlayerCondition = exhausted ? 'exhausted' : 'awake';
    players[id] = { ...p, condition, mustSubmit: condition === 'awake' };
  }

  if (isGameOver(state.order, players)) {
    log.push({ type: 'game_over', at, reason: 'all_unconscious' });
    return { ok: true, state: { ...state, players, status: 'game_over' }, log };
  }

  if (!point) {
    log.push({ type: 'finale', at });
    return { ok: true, state: { ...state, players, status: 'finale' }, log };
  }

  if (point.day !== at.day) {
    for (const id of state.order) players[id] = startDay(point.day, players[id]!, point, log);
  }
  for (const id of state.order) {
    const p = players[id]!;
    if (p.condition !== 'unconscious' || !p.knockedOut || !samePoint(p.knockedOut.wakeAt, point)) continue;
    const woke = wake(p, p.knockedOut, rng);
    players[id] = woke.player;
    log.push({ ...woke.entry, at: point });
  }

  const next: PhaseState = { ...state, ...point, players, status: 'collecting', submissions: {} };
  log.push({ type: 'phase_started', at: point });
  return { ok: true, ...closeIfComplete(next, log) };
}
