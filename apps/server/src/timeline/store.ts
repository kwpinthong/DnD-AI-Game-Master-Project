import {
  EventOutcomeText,
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

/**
 * Timeline event state machine (GEN-053, GDD §6.2). Every scenario event happens at its day + phase:
 * - `pending` until the game reaches that point,
 * - `active` for that one phase (the AI GM may set its outcome then: `setEventOutcome`),
 * - `resolved` once the game moves past it, keeping the AI's outcome or else the scenario's ผลตั้งต้น.
 * The game's point moves forward only through `advanceTimeline` (start of game = day 1 Morning).
 *
 * How later work uses this:
 * - GEN-057 (phase loop): call `advanceTimeline(tx, gameId, nextPoint)` when a phase starts (and
 *   `'end'` after day 12 Night); put `eventContextBlock(buildEventContext(...))` into `gm_adjudicate`;
 *   map the AI's `eventOutcomes` onto `applyEventOutcomes` inside the same all-or-nothing transaction
 *   as the rest of the PhaseProposal (Q-049).
 * - Later events / GEN-059 (finale): read `getEventOutcomes(gameId)`; `intervened` says whether the
 *   players changed the event. `buildEventContext` already passes past outcomes to the AI GM so later
 *   events are narrated in their light. No branching rules live here: the AI GM / finale decide.
 */

const PHASE_INDEX: Record<Phase, number> = { MORNING: 0, AFTERNOON: 1, NIGHT: 2 };
const rank = (p: PhasePoint) => (p.day - 1) * 3 + PHASE_INDEX[p.phase];
/** After day 12 Night. */
const END_RANK = 12 * 3;

/** Events by day, then Morning → Afternoon → Night; ties keep scenario order. */
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

export type AdvanceResult =
  | { ok: true; activated: string[]; resolved: string[] }
  | { ok: false; code: 'not_found' | 'backwards' };

/**
 * Moves the game to `to` (or past day 12 Night with `'end'`): events before it resolve, events at
 * it become active. Same point again = no change; an earlier point is refused. Use inside the
 * caller's transaction when it must commit together with other phase changes.
 */
export function advanceTimeline(db: DbOrTx, gameId: string, to: PhasePoint | 'end', now: number = Date.now()): AdvanceResult {
  const scenario = getGameScenario(db, gameId);
  if (!scenario) return { ok: false, code: 'not_found' };
  const cursor = readCursor(db, gameId);
  const target = to === 'end' ? END_RANK : rank(to);
  const current = cursor ? (cursor.ended ? END_RANK : rank(cursor)) : -1;
  if (target < current) return { ok: false, code: 'backwards' };
  if (target === current) return { ok: true, activated: [], resolved: [] };

  const rows = readRows(db, gameId);
  const activated: string[] = [];
  const resolved: string[] = [];
  for (const event of scenario.timeline) {
    const row = rows.get(event.id);
    const status = row?.status ?? 'pending';
    const at = rank(event);
    if (at < target && status !== 'resolved') {
      const chosen = row?.outcomeSource === 'ai' && row.outcome !== null;
      const values = {
        status: 'resolved' as const,
        outcome: chosen ? row.outcome : event.outcome,
        outcomeSource: chosen ? ('ai' as const) : ('default' as const),
        activatedAt: row?.activatedAt ?? null,
        resolvedAt: now,
        updatedAt: now,
      };
      db.insert(gameEventState)
        .values({ gameId, eventId: event.id, ...values })
        .onConflictDoUpdate({ target: [gameEventState.gameId, gameEventState.eventId], set: values })
        .run();
      resolved.push(event.id);
    } else if (at === target && status === 'pending') {
      const values = { status: 'active' as const, activatedAt: now, updatedAt: now };
      db.insert(gameEventState)
        .values({ gameId, eventId: event.id, ...values })
        .onConflictDoUpdate({ target: [gameEventState.gameId, gameEventState.eventId], set: values })
        .run();
      activated.push(event.id);
    }
  }

  const point = to === 'end' ? { day: 12, phase: 'NIGHT' as const, ended: true } : { ...to, ended: false };
  db.insert(gameTimeline)
    .values({ gameId, ...point, updatedAt: now })
    .onConflictDoUpdate({ target: gameTimeline.gameId, set: { ...point, updatedAt: now } })
    .run();
  return { ok: true, activated, resolved };
}

export type SetOutcomeCode = 'not_found' | 'not_active' | 'already_resolved' | 'invalid_outcome';
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

/**
 * The AI GM's request to change an event's outcome because players stepped in (C3). Accepted only
 * while the event is active; a later call while still active replaces the earlier choice.
 */
export function setEventOutcome(db: DbOrTx, gameId: string, eventId: string, outcome: string, now: number = Date.now()): SetOutcomeResult {
  const check = checkOutcome(db, gameId, eventId, outcome);
  if (!check.ok) return check;
  db.update(gameEventState)
    .set({ outcome: check.text!, outcomeSource: 'ai', updatedAt: now })
    .where(and(eq(gameEventState.gameId, gameId), eq(gameEventState.eventId, eventId)))
    .run();
  return { ok: true };
}

export interface EventOutcomeChange {
  eventId: string;
  outcome: string;
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
    for (const c of changes) setEventOutcome(tx, gameId, c.eventId, c.outcome, now);
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
}

/** Outcomes of resolved events in timeline order, for later events and the finale (GEN-057 / GEN-059). */
export function getEventOutcomes(db: DbOrTx, gameId: string): EventOutcomeRecord[] {
  const scenario = getGameScenario(db, gameId);
  if (!scenario) return [];
  const rows = readRows(db, gameId);
  return inPlayOrder(scenario.timeline).flatMap((e) => {
    const row = rows.get(e.id);
    if (row?.status !== 'resolved') return [];
    return [{ eventId: e.id, day: e.day, phase: e.phase, kind: e.kind, outcome: row.outcome ?? '', intervened: row.outcomeSource === 'ai' }];
  });
}
