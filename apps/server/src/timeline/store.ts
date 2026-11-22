import { turnNumber, type Turn } from '@isekai/rules';
import {
  EventOutcomeText,
  SCENARIO_DAYS,
  TURNS_PER_PERIOD,
  type EventOutcomeSide,
  type EventOutcomeSource,
  type EventStatus,
  type Phase,
  type PhasePoint,
  type Scenario,
} from '@isekai/protocol';
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { gameEventState, gameTimeline } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { settleStrategies } from '../strategy/store.ts';
import { locationSnapshot } from '../visibility/store.ts';
import { witnessesOf } from '../visibility/views.ts';

/**
 * Timeline event state machine (GEN-053, GDD §6.2). Every scenario event happens at its day + period
 * (`phase`, GEN-063):
 * - `pending` until the game reaches that point,
 * - `active` from `startTurn` of `phase` through `endTurn` of `endPhase` (GEN-071; GEN-096: default turn 1
 *   to turn 2 = every turn of its periods; the AI GM may set its outcome then: `setEventOutcome`),
 * - `resolved` once the game moves past its last turn, keeping the AI's outcome or else the scenario's
 *   ผลตั้งต้น (World_Drift_If_Ignored: outcomeSource `default` = nobody stepped in).
 * The game's point moves forward only through `advanceTimeline` (start of game = day 1 EOSORIA turn 1).
 *
 * How later work uses this:
 * - GEN-057 (turn loop): call `advanceTimeline(tx, gameId, { day, phase, turn })` when a turn starts
 *   (GEN-096: every turn), and `'end'` after day 12 NOCTHERION turn 2; put `eventContextBlock(buildEventContext(...))` into `gm_adjudicate`;
 *   map the AI's `eventOutcomes` onto `applyEventOutcomes` inside the same all-or-nothing transaction
 *   as the rest of the PhaseProposal (Q-049).
 * - Later events / GEN-059 (finale): read `getEventOutcomes(gameId)`; `intervened` says whether the
 *   players changed the event. `buildEventContext` already passes past outcomes to the AI GM so later
 *   events are narrated in their light. No branching rules live here: the AI GM / finale decide.
 */

/** A point on the timeline down to the turn (GEN-096); a point without `turn` is turn 1 of its period. */
export type TimelinePoint = PhasePoint & { turn?: Turn };

/** Turn rank (`turnNumber` of the phase engine). */
const rank = (p: TimelinePoint) => turnNumber({ day: p.day, phase: p.phase, turn: p.turn ?? 1 });
/** After day 12 NOCTHERION turn 2. */
const END_RANK = turnNumber({ day: SCENARIO_DAYS, phase: 'NOCTHERION', turn: 2 }) + 1;

type EventSpan = Pick<Scenario['timeline'][number], 'day' | 'phase' | 'endPhase' | 'startTurn' | 'endTurn'>;

/** First and last turn of an event: `startTurn` of `phase` through `endTurn` of `endPhase` (GEN-071, GEN-096), as ranks. */
export function spanOf(event: EventSpan): { first: number; last: number } {
  return {
    first: rank({ day: event.day, phase: event.phase, turn: event.startTurn }),
    last: rank({ day: event.day, phase: event.endPhase ?? event.phase, turn: event.endTurn }),
  };
}

/** Is `event` running at `at`? Without a turn: during any turn of that period. */
export const isDuring = (event: EventSpan, at: TimelinePoint) => {
  const { first, last } = spanOf(event);
  const from = rank(at.turn ? at : { ...at, turn: 1 });
  const to = rank(at.turn ? at : { ...at, turn: TURNS_PER_PERIOD });
  return first <= to && from <= last;
};

/** Events by day, then EOSORIA → SOLARION → HESPERION → NOCTHERION; ties keep scenario order. */
export function inPlayOrder<T extends PhasePoint>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => rank(a.event) - rank(b.event) || a.index - b.index)
    .map(({ event }) => event);
}

export interface TimelineEventState {
  id: string;
  day: number;
  phase: Phase;
  title: string;
  status: EventStatus;
  /** AI choice while active, final outcome once resolved; null = nothing chosen yet. */
  outcome: string | null;
  outcomeSource: EventOutcomeSource | null;
  /** Q-243: the side of the AI's outcome; null = none (always null for the scenario default). */
  outcomeSide: EventOutcomeSide | null;
}

export interface GameTimelineState {
  /** null before day 1 Morning. */
  at: PhasePoint | null;
  ended: boolean;
  /** In scenario timeline order. */
  events: TimelineEventState[];
}

type StateRow = typeof gameEventState.$inferSelect;

function readRows(db: DbOrTx, gameId: string): Map<string, StateRow> {
  const rows = db.select().from(gameEventState).where(eq(gameEventState.gameId, gameId)).all();
  return new Map(rows.map((r) => [r.eventId, r]));
}

function readCursor(db: DbOrTx, gameId: string) {
  return db.select().from(gameTimeline).where(eq(gameTimeline.gameId, gameId)).get();
}

function eventsOf(scenario: Scenario, rows: Map<string, StateRow>): TimelineEventState[] {
  return scenario.timeline.map((e) => {
    const row = rows.get(e.id);
    return {
      id: e.id,
      day: e.day,
      phase: e.phase,
      title: e.title,
      status: row?.status ?? 'pending',
      outcome: row?.outcome ?? null,
      outcomeSource: row?.outcomeSource ?? null,
      outcomeSide: row?.outcomeSide ?? null,
    };
  });
}

/** The game's timeline point and every event's state; null when the game has no scenario. */
export function getTimeline(db: DbOrTx, gameId: string): GameTimelineState | null {
  const scenario = getGameScenario(db, gameId);
  if (!scenario) return null;
  const cursor = readCursor(db, gameId);
  return {
    at: cursor ? { day: cursor.day, phase: cursor.phase } : null,
    ended: cursor?.ended ?? false,
    events: eventsOf(scenario, readRows(db, gameId)),
  };
}

/**
 * eventId → the members who were at its place when it began (Q-104), for events past `pending`.
 * null = no snapshot (town-wide event, or one that began before migration 0011).
 */
export function eventWitnesses(db: DbOrTx, gameId: string): Map<string, readonly string[] | null> {
  return new Map([...readRows(db, gameId)].map(([id, row]) => [id, row.witnesses ?? null]));
}

/** Who is at any of `event`'s places right now (GEN-097): the snapshot an event keeps from the moment it begins (Q-104). */
function witnessesAtStart(event: Scenario['timeline'][number], locations: () => ReadonlyMap<string, string>): string[] | null {
  if (event.locationIds === null) return null;
  const at = locations();
  return [...new Set(event.locationIds.flatMap((locationId) => witnessesOf({ locationId, actorMemberId: null, visibility: 'public' }, at)))];
}

export type AdvanceResult =
  | { ok: true; activated: string[]; resolved: string[] }
  | { ok: false; code: 'not_found' | 'backwards' };

/**
 * Moves the game to `to` (or past day 12 Night with `'end'`): events before it resolve, events at
 * it become active. Same point again = no change; an earlier point is refused. Use inside the
 * caller's transaction when it must commit together with other phase changes.
 */
export function advanceTimeline(db: DbOrTx, gameId: string, to: TimelinePoint | 'end', now: number = Date.now()): AdvanceResult {
  const scenario = getGameScenario(db, gameId);
  if (!scenario) return { ok: false, code: 'not_found' };
  const cursor = readCursor(db, gameId);
  const target = to === 'end' ? END_RANK : rank(to);
  const current = cursor ? (cursor.ended ? END_RANK : rank(cursor)) : -1;
  if (target < current) return { ok: false, code: 'backwards' };
  if (target === current) return { ok: true, activated: [], resolved: [] };

  const rows = readRows(db, gameId);
  let snapshot: ReadonlyMap<string, string> | undefined;
  const locations = () => (snapshot ??= locationSnapshot(db, gameId));
  const activated: string[] = [];
  const resolved: string[] = [];
  for (const event of scenario.timeline) {
    const row = rows.get(event.id);
    const status = row?.status ?? 'pending';
    const { first, last } = spanOf(event);
    if (last < target && status !== 'resolved') {
      const chosen = row?.outcomeSource === 'ai' && row.outcome !== null;
      const values = {
        status: 'resolved' as const,
        outcome: chosen ? row.outcome : event.outcome,
        outcomeSource: chosen ? ('ai' as const) : ('default' as const),
        outcomeSide: chosen ? (row.outcomeSide ?? null) : null,
        activatedAt: row?.activatedAt ?? null,
        resolvedAt: now,
        // Skipped straight past (never active): it happens now, so the snapshot is taken now.
        witnesses: status === 'pending' ? witnessesAtStart(event, locations) : (row?.witnesses ?? null),
        updatedAt: now,
      };
      db.insert(gameEventState)
        .values({ gameId, eventId: event.id, ...values })
        .onConflictDoUpdate({ target: [gameEventState.gameId, gameEventState.eventId], set: values })
        .run();
      // GEN-093: the night of day 10 is over, so its plans end (or the drift stands).
      if (event.strategyIds.length > 0) settleStrategies(db, gameId, now);
      resolved.push(event.id);
    } else if (first <= target && target <= last && status === 'pending') {
      const values = { status: 'active' as const, activatedAt: now, witnesses: witnessesAtStart(event, locations), updatedAt: now };
      db.insert(gameEventState)
        .values({ gameId, eventId: event.id, ...values })
        .onConflictDoUpdate({ target: [gameEventState.gameId, gameEventState.eventId], set: values })
        .run();
      activated.push(event.id);
    }
  }

  const point =
    to === 'end'
      ? { day: SCENARIO_DAYS, phase: 'NOCTHERION' as const, turn: TURNS_PER_PERIOD as Turn, ended: true }
      : { day: to.day, phase: to.phase, turn: to.turn ?? 1, ended: false };
  db.insert(gameTimeline)
    .values({ gameId, ...point, updatedAt: now })
    .onConflictDoUpdate({ target: gameTimeline.gameId, set: { ...point, updatedAt: now } })
    .run();
  return { ok: true, activated, resolved };
}

/**
 * GEN-058: an event the Human GM added for the period the game is in now. `advanceTimeline` only activates
 * events when the game moves, so this one becomes active here (witnesses as of now), for the turns left in
 * the period. Does nothing unless the event is in the scenario, still pending, and running at the current turn.
 */
export function activateCurrentEvent(db: DbOrTx, gameId: string, eventId: string, now: number = Date.now()): boolean {
  const event = getGameScenario(db, gameId)?.timeline.find((e) => e.id === eventId);
  const cursor = readCursor(db, gameId);
  if (!event || !cursor || cursor.ended || !isDuring(event, cursor)) return false;
  if ((readRows(db, gameId).get(eventId)?.status ?? 'pending') !== 'pending') return false;
  const values = { status: 'active' as const, activatedAt: now, witnesses: witnessesAtStart(event, () => locationSnapshot(db, gameId)), updatedAt: now };
  db.insert(gameEventState)
    .values({ gameId, eventId, ...values })
    .onConflictDoUpdate({ target: [gameEventState.gameId, gameEventState.eventId], set: values })
    .run();
  return true;
}

/** Where the game is on the timeline; null before day 1 EOSORIA. `ended` after day 12 NOCTHERION. */
export function timelinePoint(db: DbOrTx, gameId: string): (PhasePoint & { turn: Turn; ended: boolean }) | null {
  const cursor = readCursor(db, gameId);
  return cursor ? { day: cursor.day, phase: cursor.phase, turn: cursor.turn, ended: cursor.ended } : null;
}

/** Whether the period of `a` is earlier on the timeline than the period of `b` (turns ignored). */
export function isBefore(a: PhasePoint, b: PhasePoint): boolean {
  return rank({ day: a.day, phase: a.phase }) < rank({ day: b.day, phase: b.phase });
}

export type SetOutcomeCode ='not_found' | 'not_active' | 'already_resolved' | 'invalid_outcome';
export type SetOutcomeResult = { ok: true } | { ok: false; code: SetOutcomeCode; message: string };

const MESSAGES: Record<SetOutcomeCode, string> = {
  not_found: 'ไม่มีเหตุการณ์นี้ในเกม',
  not_active: 'เหตุการณ์นี้ยังไม่เกิด จึงเปลี่ยนผลไม่ได้',
  already_resolved: 'เหตุการณ์นี้จบไปแล้ว จึงเปลี่ยนผลไม่ได้',
  invalid_outcome: 'ผลของเหตุการณ์ต้องเป็นข้อความ 1-1000 ตัวอักษร',
};

function checkOutcome(db: DbOrTx, gameId: string, eventId: string, outcome: unknown): SetOutcomeResult & { text?: string } {
  const fail = (code: SetOutcomeCode) => ({ ok: false as const, code, message: MESSAGES[code] });
  const scenario = getGameScenario(db, gameId);
  if (!scenario || !scenario.timeline.some((e) => e.id === eventId)) return fail('not_found');
  const row = db
    .select({ status: gameEventState.status })
    .from(gameEventState)
    .where(and(eq(gameEventState.gameId, gameId), eq(gameEventState.eventId, eventId)))
    .get();
  const status = row?.status ?? 'pending';
  if (status === 'pending') return fail('not_active');
  if (status === 'resolved') return fail('already_resolved');
  const parsed = EventOutcomeText.safeParse(outcome);
  if (!parsed.success) return fail('invalid_outcome');
  return { ok: true, text: parsed.data };
}

/** The side name an outcome text began with before Q-243 ("Good: ...", "Good/Neutral: ...", "Evil: ...", "Neutral: ..."). */
const SIDE_PREFIX = /^\s*(good|evil|neutral)(?:\s*\/\s*(?:good|evil|neutral))*\s*:\s*/i;

/** Whether an outcome text begins with a side name the old way (the side belongs in `side`, Q-243). */
export const hasSidePrefix = (outcome: string) => SIDE_PREFIX.test(outcome);

/**
 * An outcome written before Q-243, when the side was the first word of the text: the text without it and the
 * side it named (the first one of "Good/Neutral"); text without such a prefix has no side.
 */
export function splitSidePrefix(outcome: string): { outcome: string; side: EventOutcomeSide | null } {
  const prefix = SIDE_PREFIX.exec(outcome);
  const rest = prefix ? outcome.slice(prefix[0].length) : '';
  return prefix && rest.trim().length > 0 ? { outcome: rest, side: prefix[1]!.toLowerCase() as EventOutcomeSide } : { outcome, side: null };
}

/**
 * The AI GM's request to change an event's outcome because players stepped in (C3). Accepted only
 * while the event is active; a later call while still active replaces the earlier choice (text and side).
 * `side` (Q-243): the side of the outcome, null = none; undefined = an answer stored before the field
 * existed, whose side is read from the old "Good: ..." prefix of the text.
 */
export function setEventOutcome(
  db: DbOrTx,
  gameId: string,
  eventId: string,
  outcome: string,
  side?: EventOutcomeSide | null,
  now: number = Date.now(),
): SetOutcomeResult {
  const given = side === undefined ? splitSidePrefix(outcome) : { outcome, side };
  const check = checkOutcome(db, gameId, eventId, given.outcome);
  if (!check.ok) return check;
  db.update(gameEventState)
    .set({ outcome: check.text!, outcomeSource: 'ai', outcomeSide: given.side, updatedAt: now })
    .where(and(eq(gameEventState.gameId, gameId), eq(gameEventState.eventId, eventId)))
    .run();
  return { ok: true };
}

export interface EventOutcomeChange {
  eventId: string;
  outcome: string;
  /** As `setEventOutcome`. */
  side?: EventOutcomeSide | null;
}

export type ApplyOutcomesResult =
  | { ok: true }
  | { ok: false; errors: { index: number; eventId: string; code: SetOutcomeCode; message: string }[] };

/** Several outcome requests from one AI proposal: all are written, or none (Q-049). */
export function applyEventOutcomes(db: Db, gameId: string, changes: readonly EventOutcomeChange[], now: number = Date.now()): ApplyOutcomesResult {
  return db.transaction((tx) => {
    const errors = changes.flatMap((c, index) => {
      const check = checkOutcome(tx, gameId, c.eventId, c.outcome);
      return check.ok ? [] : [{ index, eventId: c.eventId, code: check.code, message: check.message }];
    });
    if (errors.length > 0) return { ok: false, errors };
    for (const c of changes) setEventOutcome(tx, gameId, c.eventId, c.outcome, c.side, now);
    return { ok: true };
  });
}

export interface EventOutcomeRecord {
  eventId: string;
  day: number;
  phase: Phase;
  kind: Scenario['timeline'][number]['kind'];
  outcome: string;
  /** true = the AI GM set it because players stepped in; false = the scenario default. */
  intervened: boolean;
  /** Q-243: the side of the outcome the AI GM chose; null = none (always null when nobody stepped in). */
  side: EventOutcomeSide | null;
}

/** Outcomes of resolved events in timeline order, for later events and the finale (GEN-057 / GEN-059). */
export function getEventOutcomes(db: DbOrTx, gameId: string): EventOutcomeRecord[] {
  const scenario = getGameScenario(db, gameId);
  if (!scenario) return [];
  const rows = readRows(db, gameId);
  return inPlayOrder(scenario.timeline).flatMap((e) => {
    const row = rows.get(e.id);
    if (row?.status !== 'resolved') return [];
    return [{ eventId: e.id, day: e.day, phase: e.phase, kind: e.kind, outcome: row.outcome ?? '', intervened: row.outcomeSource === 'ai', side: row.outcomeSide ?? null }];
  });
}
