/**
 * Travel on the game's database (GEN-066): who is where (character_presence), the trip that ends with the
 * turn (travel_pending), and the Stamina it costs (the turn engine's stored state). The play room calls
 * `travel` for a player's `move`; the AI GM loop (GEN-057) calls it too, with the facts the room does not
 * have yet (weather, the start scenario's right, an INFILTRATE roll, the black market's password).
 *
 * Place ids are Location names (rules.ts). A game whose scenario still has its own place ids (the default
 * scenario's `inn`, `market`, ...) keeps them: a presence id is read as a Location name, else as the
 * scenario place whose name is a Location name; a move into a place the scenario has under a Location name
 * stores the scenario's id, anything else stores the Location name.
 */
import { phaseStep, resolveAction, type PhaseState, type PlayerResult, type ResolutionInput, type ResolutionLog, type Rng } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { Weather } from '../assets/model.ts';
import type { DbOrTx } from '../db/client.ts';
import { travelPending } from '../db/schema.ts';
import { CryptoRng } from '../rng.ts';
import { ensurePhaseState, karmaOf, recordAction, savePhaseState, syncCharacterStats } from '../room/store.ts';
import { getGameScenario } from '../scenario/store.ts';
import { originOf } from '../game/origin.ts';
import { START_RULES } from '../game/start-rules.ts';
import { locationSnapshot, moveCharacter, presenceOf } from '../visibility/store.ts';
import { hazardStaminaLoss, npcsAt, placeMap, planMove, type MoveKind, type MoveRefusal, type Place, type PlaceMap } from './rules.ts';

export interface TravelRequest {
  /** A place id (Location name). */
  readonly to: string;
  /** Default none (GEN-068 decides the weather later). */
  readonly weather?: Weather | null;
  /** The player's Start_Scenarios `name` (GEN-065); default the stored start scenario; null = none. */
  readonly startScenario?: string | null;
  readonly blackMarketPassword?: boolean;
  /** INFILTRATE: the resolution engine rolls this; success / crit lets the player into a restricted place. */
  readonly infiltrate?: { readonly input: ResolutionInput; readonly rng: Rng };
}

export type TravelCode = MoveRefusal | 'traveling' | 'not_placed' | 'cannot_act' | 'infiltrate_invalid';

export type TravelOutcome =
  | {
      readonly ok: true;
      readonly kind: MoveKind;
      readonly place: { readonly id: string; readonly name: string };
      readonly arrives: 'now' | 'next_turn';
      /** The turn engine state after the move (already saved). */
      readonly state: PhaseState;
      readonly infiltration: ResolutionLog | null;
    }
  | { readonly ok: false; readonly code: TravelCode; readonly message: string; readonly infiltration: ResolutionLog | null };

/**
 * Moves `memberId` while the turn collects actions. Same zone / into the rift: there now, Stamina paid now.
 * Another zone: Stamina paid now, the trip becomes this turn's action, and the character arrives when the
 * turn closes (`completeTravel`). A refusal changes nothing (except the Stamina an INFILTRATE roll cost).
 */
export function travel(db: DbOrTx, assets: GameAssets, gameId: string, memberId: string, request: TravelRequest, now: number): TravelOutcome {
  const no = (code: TravelCode, message: string, infiltration: ResolutionLog | null = null): TravelOutcome => ({ ok: false, code, message, infiltration });
  let state = ensurePhaseState(db, gameId, now);
  const player = state.players[memberId];
  if (state.status !== 'collecting' || !player || player.condition !== 'awake') return no('cannot_act', CANNOT_ACT_MESSAGE);
  if (pendingOf(db, memberId)) return no('traveling', TRAVELING_MESSAGE);
  const presence = presenceOf(db, memberId);
  if (!presence || presence.gameId !== gameId) return no('not_placed', NOT_PLACED_MESSAGE);

  const map = placeMap(assets);
  const scenario = getGameScenario(db, gameId);
  const from = placeOfPresence(map, scenario, presence.locationId);
  let stamina = player.stamina;

  // INFILTRATE: the resolution engine rolls; the attempt costs its Stamina whatever the outcome.
  let infiltration: ResolutionLog | null = null;
  if (request.infiltrate) {
    const rolled = resolveAction(request.infiltrate.input, request.infiltrate.rng);
    if (!rolled.ok) return no('infiltrate_invalid', rolled.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
    infiltration = rolled.log;
    stamina = Math.max(0, stamina - (rolled.log.stamina.before - rolled.log.stamina.after));
  }

  // The player's stored start scenario (GEN-065) unless the caller names one.
  const startScenario = request.startScenario !== undefined ? request.startScenario : (originOf(db, memberId)?.startScenario ?? null);
  const spawnPlace = startScenario ? (assets.startScenarios.find((s) => s.name === startScenario)?.location ?? null) : null;
  const restrictedAccess = startScenario ? START_RULES[startScenario]?.restrictedAccess === true : false;
  const plan = planMove(map, from, request.to, {
    day: state.day,
    phase: state.phase,
    stamina,
    karma: karmaOf(db, [memberId]).get(memberId) ?? 0,
    weather: request.weather ?? null,
    spawnPlace,
    restrictedAccess,
    blackMarketPassword: request.blackMarketPassword === true,
    ...(infiltration ? { infiltration: infiltration.degree } : {}),
  });
  if (!plan.ok) {
    if (stamina !== player.stamina) saveStamina(db, gameId, state, memberId, stamina, now);
    return no(plan.code, plan.message, infiltration);
  }

  state = withStamina(state, memberId, stamina - plan.staminaCost);
  const stored = storedId(scenario, plan.to);
  if (plan.spendsTurn) {
    // The trip is this turn's action (it replaces a draft), so the turn may close on it.
    const action = { text: `เดินทางไป${plan.to.name}`, visibility: 'public' as const, rest: false };
    const step = phaseStep(state, { type: 'submit', playerId: memberId, action }, new CryptoRng());
    if (!step.ok) return no('cannot_act', CANNOT_ACT_MESSAGE, infiltration);
    state = step.state;
    recordAction(db, gameId, { day: state.day, phase: state.phase, turn: state.turn }, memberId, action, now);
    db.insert(travelPending).values({ memberId, gameId, locationId: stored, kind: 'arrive', createdAt: now }).run();
  } else {
    moveCharacter(db, memberId, stored, now);
    if (plan.kind === 'rift' && from) {
      db.insert(travelPending).values({ memberId, gameId, locationId: presence.locationId, kind: 'return', createdAt: now }).run();
    }
  }
  savePhaseState(db, gameId, state, now);
  syncCharacterStats(db, state, now);
  return {
    ok: true,
    kind: plan.kind,
    place: { id: stored, name: plan.to.name },
    arrives: plan.spendsTurn ? 'next_turn' : 'now',
    state,
    infiltration,
  };
}

const CANNOT_ACT_MESSAGE = 'ตอนนี้ย้ายที่ไม่ได้';
const TRAVELING_MESSAGE = 'กำลังเดินทาง เทิร์นนี้ใช้ไปกับการเดินทางแล้ว';
const NOT_PLACED_MESSAGE = 'ตัวละครยังไม่อยู่ในเมือง';

type ScenarioPlaces = { readonly locations: readonly { readonly id: string; readonly name: string }[] } | null | undefined;

/** A presence id as a Location name, else as a scenario place whose name is a Location name; null = unknown. */
function placeOfPresence(map: PlaceMap, scenario: ScenarioPlaces, locationId: string): Place | null {
  const name = scenario?.locations.find((l) => l.id === locationId)?.name;
  return map.place(locationId) ?? (name === undefined ? undefined : map.place(name)) ?? null;
}

/** What the presence stores for `place`: the scenario's own id when it has the place under its name. */
function storedId(scenario: ScenarioPlaces, place: Place): string {
  return scenario?.locations.find((l) => l.name === place.name)?.id ?? place.id;
}

function withStamina(state: PhaseState, memberId: string, stamina: number): PhaseState {
  return { ...state, players: { ...state.players, [memberId]: { ...state.players[memberId]!, stamina } } };
}

function saveStamina(db: DbOrTx, gameId: string, state: PhaseState, memberId: string, stamina: number, now: number): void {
  const next = withStamina(state, memberId, stamina);
  savePhaseState(db, gameId, next, now);
  syncCharacterStats(db, next, now);
}

function pendingOf(db: DbOrTx, memberId: string) {
  return db.select().from(travelPending).where(eq(travelPending.memberId, memberId)).get();
}

/** Where `memberId` is going this turn (a trip to another zone); null = not travelling. */
export function travellingTo(db: DbOrTx, memberId: string): string | null {
  const pending = pendingOf(db, memberId);
  return pending?.kind === 'arrive' ? pending.locationId : null;
}

/** Whether `memberId`'s move this turn is still running (a trip, or a turn in the rift). */
export function isTravelling(db: DbOrTx, memberId: string): boolean {
  return pendingOf(db, memberId) !== undefined;
}

/** The results with the HAZARD_DAY5 Stamina loss of everyone who spent the closing turn in the forest / at the sea. */
export function withHazard(
  db: DbOrTx,
  assets: GameAssets,
  gameId: string,
  state: PhaseState,
  results: Readonly<Record<string, PlayerResult>>,
): Record<string, PlayerResult> {
  const map = placeMap(assets);
  const scenario = getGameScenario(db, gameId);
  const out: Record<string, PlayerResult> = { ...results };
  for (const [memberId, locationId] of locationSnapshot(db, gameId)) {
    const player = state.players[memberId];
    const loss = hazardStaminaLoss(placeOfPresence(map, scenario, locationId), state.day);
    if (!player || loss === 0) continue;
    out[memberId] = { ...out[memberId], stamina: Math.max(0, (out[memberId]?.stamina ?? player.stamina) - loss) };
  }
  return out;
}

/** At the turn close: trips arrive and rift visitors go back to where they came from. */
export function completeTravel(db: DbOrTx, gameId: string, now: number): void {
  for (const pending of db.select().from(travelPending).where(eq(travelPending.gameId, gameId)).all()) {
    moveCharacter(db, pending.memberId, pending.locationId, now);
  }
  db.delete(travelPending).where(eq(travelPending.gameId, gameId)).run();
}

/** NPCs the schedule puts where `memberId` is, in the current period (Q-092). */
export function npcsMetBy(db: DbOrTx, assets: GameAssets, gameId: string, memberId: string, weather: Weather | null = null): string[] {
  const presence = presenceOf(db, memberId);
  if (!presence || presence.gameId !== gameId || !assets.npcSchedule) return [];
  const place = placeOfPresence(placeMap(assets), getGameScenario(db, gameId), presence.locationId);
  if (!place) return [];
  const state = ensurePhaseState(db, gameId, Date.now());
  return npcsAt(assets.npcSchedule, place.name, { phase: state.phase, weather, karma: karmaOf(db, [memberId]).get(memberId) ?? 0 });
}
