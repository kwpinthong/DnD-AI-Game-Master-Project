import {
  GmAdjustRequest,
  GmInsertEventRequest,
  GmTurnEditRequest,
  PHASES,
  SCENARIO_DAYS,
  type ApiError,
  type GmActionView,
  type GmConsoleResponse,
  type GmOverrideKind,
  type GmOverrideView,
  type GmPendingTurn,
  type GmStats,
  type GmTimelineEvent,
  type GmTurnPoint,
  type Scenario,
} from '@isekai/protocol';
import { AFFINITY_MAX, AFFINITY_MIN, KARMA_MAX, KARMA_MIN, phaseStep, type PhaseState, type PlayerResult } from '@isekai/rules';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { GameAssets } from '../assets/load.ts';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, gmOverride, member, npcBond, phaseAction } from '../db/schema.ts';
import type { MemberRow } from '../game/service.ts';
import type { PhaseResolution } from '../room/resolver.ts';
import type { HeldTurn, RoomService } from '../room/service.ts';
import { ensurePhaseState, karmaOf, savePhaseState } from '../room/store.ts';
import { CryptoRng } from '../rng.ts';
import { getGameScenario, updateGameScenario } from '../scenario/store.ts';
import { activateCurrentEvent, getTimeline, isBefore, timelinePoint } from '../timeline/store.ts';
import { surroundingsFor } from '../visibility/views.ts';

/**
 * The Human GM console (GEN-058). Reads everything of the game for the GM, and changes it only within the
 * rules, each change logged (`gm_override`) with who, what and why:
 * - a held turn (Q-030): narration text and each player's HP / Stamina / Karma after the turn, then approve;
 * - between turns: one HP / Stamina / Karma / affinity value by hand;
 * - a new timeline event, now or later in the game.
 * Callers have checked that `gm` is the game's Human GM.
 */

export type ConsoleFailure = { status: 400 | 409; body: ApiError };
export type ConsoleResult<T> = { ok: true; value: T } | { ok: false; failure: ConsoleFailure };

const ok = <T>(value: T): ConsoleResult<T> => ({ ok: true, value });
const invalid = (fields: Record<string, string>): ConsoleResult<never> => ({
  ok: false,
  failure: { status: 400, body: { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields } },
});
const notAllowed = (message: string): ConsoleResult<never> => ({ ok: false, failure: { status: 409, body: { code: 'not_allowed', message } } });

/** Field path → its first Thai message. */
function fieldsOf(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'body';
    fields[key] ??= issue.message;
  }
  return fields;
}

const NO_HELD_TURN = 'ตอนนี้ไม่มีผลของเทิร์นที่รออนุมัติ';
const pointOf = (state: PhaseState): GmTurnPoint => ({ day: state.day, phase: state.phase, turn: state.turn });

// --- The override log ---

function logOverride(
  db: DbOrTx,
  gm: MemberRow,
  o: { kind: GmOverrideKind; at: GmTurnPoint; target: string; before: unknown; after: unknown; reason: string },
  now: number,
): number {
  return db
    .insert(gmOverride)
    .values({
      gameId: gm.gameId,
      gmMemberId: gm.id,
      kind: o.kind,
      day: o.at.day,
      phase: o.at.phase,
      turn: o.at.turn,
      target: o.target,
      before: JSON.stringify(o.before ?? null),
      after: JSON.stringify(o.after ?? null),
      reason: o.reason,
      createdAt: now,
    })
    .returning({ id: gmOverride.id })
    .get().id;
}

export function overrideLog(db: DbOrTx, gameId: string): GmOverrideView[] {
  return db
    .select({ o: gmOverride, gmName: member.name })
    .from(gmOverride)
    .innerJoin(member, eq(member.id, gmOverride.gmMemberId))
    .where(eq(gmOverride.gameId, gameId))
    .orderBy(asc(gmOverride.id))
    .all()
    .map(({ o, gmName }) => ({
      id: o.id,
      gmMemberId: o.gmMemberId,
      gmName,
      kind: o.kind,
      at: { day: o.day, phase: o.phase, turn: o.turn === 2 ? 2 : 1 },
      target: o.target,
      before: JSON.parse(o.before) as unknown,
      after: JSON.parse(o.after) as unknown,
      reason: o.reason,
      createdAt: o.createdAt,
    }));
}

// --- Held turn: edits are read back from the log, so a restart before the approval keeps them ---

type StatField = keyof GmStats;
const STAT_FIELDS: readonly StatField[] = ['hp', 'stamina', 'karma'];

interface TurnEdits {
  narrations: Map<number, string>;
  results: Map<string, Partial<GmStats>>;
}

function turnEdits(db: DbOrTx, gameId: string, at: GmTurnPoint): TurnEdits {
  const edits: TurnEdits = { narrations: new Map(), results: new Map() };
  const rows = db
    .select()
    .from(gmOverride)
    .where(and(eq(gmOverride.gameId, gameId), eq(gmOverride.day, at.day), eq(gmOverride.phase, at.phase), eq(gmOverride.turn, at.turn)))
    .orderBy(asc(gmOverride.id))
    .all();
  for (const row of rows) {
    const after = JSON.parse(row.after) as unknown;
    if (row.kind === 'narration' && typeof after === 'string') edits.narrations.set(Number(row.target.slice('entry:'.length)), after);
    if (row.kind === 'result' && typeof after === 'number') {
      const dot = row.target.lastIndexOf('.');
      const memberId = row.target.slice(0, dot);
      const field = row.target.slice(dot + 1) as StatField;
      edits.results.set(memberId, { ...edits.results.get(memberId), [field]: after });
    }
  }
  return edits;
}

/** The held turn as the GM's edits change it; Karma edits are written after the turn's own `apply`. */
function editedResolution(turn: HeldTurn, edits: TurnEdits): PhaseResolution {
  const { resolution } = turn;
  const results: Record<string, PlayerResult> = { ...resolution.results };
  for (const [id, r] of edits.results) results[id] = { ...results[id], ...r };
  const karmaEdits = [...edits.results].flatMap(([id, r]) => (r.karma === undefined ? [] : [[id, r.karma] as const]));
  return {
    ...resolution,
    results,
    entries: (resolution.entries ?? []).map((e, i) => (edits.narrations.has(i) ? { ...e, text: edits.narrations.get(i)! } : e)),
    apply: (tx) => {
      resolution.apply?.(tx);
      for (const [id, karma] of karmaEdits) tx.update(character).set({ karma }).where(eq(character.memberId, id)).run();
    },
  };
}

function pendingView(db: DbOrTx, gameId: string, turn: HeldTurn): GmPendingTurn {
  const edits = turnEdits(db, gameId, turn.at);
  const edited = editedResolution(turn, edits);
  const karma = karmaOf(db, turn.state.order);
  return {
    ...(turn.finale ? { finale: true } : {}),
    at: turn.at,
    entries: (edited.entries ?? []).map((e, index) => ({
      index,
      kind: e.kind,
      memberId: e.kind === 'narration' ? e.memberId : null,
      locationId: e.kind === 'feed' ? e.locationId : null,
      text: e.text,
      edited: edits.narrations.has(index),
    })),
    results: turn.state.order.map((memberId) => {
      const p = turn.state.players[memberId]!;
      const before = { hp: p.hp, stamina: p.stamina, karma: karma.get(memberId) ?? p.karma };
      const r = edited.results?.[memberId] ?? {};
      return {
        memberId,
        before,
        after: { hp: r.hp ?? before.hp, stamina: r.stamina ?? before.stamina, karma: r.karma ?? before.karma },
        edited: edits.results.has(memberId),
      };
    }),
  };
}

// --- Rules caps (C3) ---

interface Caps {
  hpMax: number;
  staminaMax: number;
}

const STAT_LABEL: Record<StatField | 'affinity', string> = { hp: 'HP', stamina: 'Stamina', karma: 'Karma', affinity: 'ค่าความสัมพันธ์ (affinity)' };

/** The Thai problem with `value` for `field`, or null. HP / Stamina use the character's own max (GEN-069). */
function capProblem(field: StatField | 'affinity', value: number, caps: Caps, min?: number): string | null {
  const [lo, hi] =
    field === 'hp' ? [min ?? 0, caps.hpMax] : field === 'stamina' ? [min ?? 0, caps.staminaMax] : field === 'karma' ? [KARMA_MIN, KARMA_MAX] : [AFFINITY_MIN, AFFINITY_MAX];
  return Number.isInteger(value) && value >= lo && value <= hi ? null : `${STAT_LABEL[field]} ต้องเป็นจำนวนเต็ม ${lo} ถึง ${hi} ตามกฎ`;
}

function capsOf(db: DbOrTx, memberId: string): Caps | undefined {
  return db.select({ hpMax: character.hpMax, staminaMax: character.staminaMax }).from(character).where(eq(character.memberId, memberId)).get();
}

// --- Console reads ---

function actionsOf(db: DbOrTx, gameId: string): GmActionView[] {
  const rows = db.select().from(phaseAction).where(eq(phaseAction.gameId, gameId)).all();
  const order = (r: (typeof rows)[number]) => [r.day, PHASES.indexOf(r.phase), r.turn, r.submittedAt];
  rows.sort((a, b) => {
    const x = order(a);
    const y = order(b);
    return x.reduce((d, v, i) => d || v - y[i]!, 0);
  });
  return rows.map((r) => ({ memberId: r.memberId, day: r.day, phase: r.phase, turn: r.turn === 2 ? 2 : 1, text: r.text, visibility: r.visibility, rest: r.rest }));
}

function timelineEvents(db: DbOrTx, gameId: string): GmTimelineEvent[] {
  return (getTimeline(db, gameId)?.events ?? []).map(({ id, day, phase, title, status, outcome, outcomeSource }) => ({ id, day, phase, title, status, outcome, outcomeSource }));
}

export function consoleView(db: Db, room: RoomService, assets: GameAssets, gm: MemberRow, now: number): GmConsoleResponse {
  // A closed turn left by a restart starts resolving when the GM looks, not only when someone enters the room.
  room.wake(gm.gameId);
  const state = ensurePhaseState(db, gm.gameId, now);
  const seen = surroundingsFor(db, gm, assets);
  const turn = room.heldTurn(gm.gameId);
  return {
    view: 'gm',
    at: pointOf(state),
    status: state.status,
    characters: seen.view === 'gm' ? seen.characters : [],
    evidence: seen.view === 'gm' ? seen.evidence : [],
    actions: actionsOf(db, gm.gameId),
    events: timelineEvents(db, gm.gameId),
    legendaries: getGameScenario(db, gm.gameId)?.legendaries ?? [],
    pending: turn ? pendingView(db, gm.gameId, turn) : null,
  };
}

// --- Held turn: edit and approve (C2) ---

export function editTurn(db: Db, room: RoomService, gm: MemberRow, input: unknown, now: number): ConsoleResult<GmPendingTurn> {
  const parsed = GmTurnEditRequest.safeParse(input ?? {});
  if (!parsed.success) return invalid(fieldsOf(parsed.error));
  const turn = room.heldTurn(gm.gameId);
  if (!turn) return notAllowed(NO_HELD_TURN);
  const { reason, narrations, results } = parsed.data;

  const entries = turn.resolution.entries ?? [];
  const problems: Record<string, string> = {};
  // GEN-059 (Q-205): the ending is text only; the game is over, so no HP / Stamina / Karma changes.
  if (turn.finale && results.length > 0) problems.results = 'ตอนจบแก้ได้เฉพาะข้อความ เกมจบแล้วจึงแก้ HP / Stamina / Karma ไม่ได้';
  narrations.forEach((n, i) => {
    if (n.index < 0 || n.index >= entries.length) problems[`narrations.${i}.index`] = 'ไม่มีข้อความลำดับนี้ในผลของเทิร์น';
  });
  results.forEach((r, i) => {
    const caps = turn.state.players[r.memberId] ? capsOf(db, r.memberId) : undefined;
    if (!caps) {
      problems[`results.${i}.memberId`] = 'ไม่มีผู้เล่นคนนี้ในเทิร์นนี้';
      return;
    }
    for (const field of STAT_FIELDS) {
      const value = r[field];
      const problem = value === undefined ? null : capProblem(field, value, caps);
      if (problem) problems[`results.${i}.${field}`] = problem;
    }
  });
  if (Object.keys(problems).length > 0) return invalid(problems);

  // The engine checks the edited result the same way it checks the AI GM's (`PlayerResult` rules).
  const current = editedResolution(turn, turnEdits(db, gm.gameId, turn.at));
  const merged: Record<string, PlayerResult> = { ...current.results };
  for (const r of results) merged[r.memberId] = { ...merged[r.memberId], ...withoutUndefined(r) };
  const step = turn.finale ? { ok: true } : phaseStep(turn.state, { type: 'resolved', results: merged }, new CryptoRng());
  if (!step.ok) return invalid({ results: 'ผลนี้ผิดกฎของเกม ตรวจ HP / Stamina / Karma อีกครั้ง' });

  const before = pendingView(db, gm.gameId, turn);
  db.transaction((tx) => {
    for (const n of narrations) {
      const old = before.entries[n.index]!.text;
      if (old !== n.text) logOverride(tx, gm, { kind: 'narration', at: turn.at, target: `entry:${n.index}`, before: old, after: n.text, reason }, now);
    }
    for (const r of results) {
      const old = before.results.find((x) => x.memberId === r.memberId)!.after;
      for (const field of STAT_FIELDS) {
        const value = r[field];
        if (value !== undefined && value !== old[field]) {
          logOverride(tx, gm, { kind: 'result', at: turn.at, target: `${r.memberId}.${field}`, before: old[field], after: value, reason }, now);
        }
      }
    }
  });
  return ok(pendingView(db, gm.gameId, turn));
}

function withoutUndefined(r: { hp?: number | undefined; stamina?: number | undefined; karma?: number | undefined }): PlayerResult {
  return Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'memberId' && v !== undefined)) as PlayerResult;
}

export function approveTurn(db: Db, room: RoomService, gm: MemberRow): ConsoleResult<{ approved: GmTurnPoint }> {
  const turn = room.heldTurn(gm.gameId);
  if (!turn) return notAllowed(NO_HELD_TURN);
  const published = room.approve(gm.gameId, (t) => editedResolution(t, turnEdits(db, gm.gameId, t.at)));
  if (!published) return notAllowed('เผยแพร่ผลของเทิร์นนี้ไม่ได้ ลองใหม่อีกครั้ง');
  return ok({ approved: turn.at });
}

// --- One value by hand (C3) ---

export function adjustValue(db: Db, gm: MemberRow, input: unknown, now: number): ConsoleResult<GmOverrideView> {
  const parsed = GmAdjustRequest.safeParse(input ?? {});
  if (!parsed.success) return invalid(fieldsOf(parsed.error));
  const req = parsed.data;
  const state = ensurePhaseState(db, gm.gameId, now);
  const player = state.players[req.memberId];
  const caps = player ? capsOf(db, req.memberId) : undefined;
  if (!player || !caps) return invalid({ memberId: 'ไม่มีตัวละครคนนี้ในเกม' });
  if (req.field === 'affinity' && !getGameScenario(db, gm.gameId)?.npcs.some((n) => n.id === req.npcId)) {
    return invalid({ npcId: 'ไม่มี NPC นี้ในเกม' });
  }
  // Setting HP / Stamina to 0 by hand would skip what the rules do then (knock-out, exhaustion): only a turn's result does that.
  const problem = capProblem(req.field, req.value, caps, 1);
  if (problem) return invalid({ value: req.field === 'hp' || req.field === 'stamina' ? `${problem} (ให้เหลือ 0 ได้ผ่านผลของเทิร์นเท่านั้น)` : problem });
  if (state.status === 'finale' || state.status === 'game_over') return notAllowed('เกมจบแล้ว แก้ค่าไม่ได้');
  if (state.status !== 'collecting') return notAllowed('เทิร์นนี้ปิดรับแล้ว แก้ค่าในผลของเทิร์นที่รออนุมัติแทน');
  if ((req.field === 'hp' || req.field === 'stamina') && player.condition !== 'awake') {
    return notAllowed('ตัวละครนี้หมดสติหรือหมดแรงอยู่ แก้ HP / Stamina ได้ในผลของเทิร์น');
  }

  const id = db.transaction((tx) => {
    if (req.field === 'affinity') {
      const row = tx.select({ affinity: npcBond.affinity }).from(npcBond).where(and(eq(npcBond.memberId, req.memberId), eq(npcBond.npcId, req.npcId))).get();
      // The number only: a name reveal, its rewards and evolution come from actions (GEN-054), not from the GM's hand.
      tx.insert(npcBond)
        .values({ memberId: req.memberId, npcId: req.npcId, affinity: req.value, updatedAt: now })
        .onConflictDoUpdate({ target: [npcBond.memberId, npcBond.npcId], set: { affinity: req.value, updatedAt: now } })
        .run();
      const target = `${req.memberId}.affinity.${req.npcId}`;
      return logOverride(tx, gm, { kind: 'adjust', at: pointOf(state), target, before: row?.affinity ?? 0, after: req.value, reason: req.reason }, now);
    }
    const before = req.field === 'karma' ? (karmaOf(tx, [req.memberId]).get(req.memberId) ?? player.karma) : player[req.field];
    tx.update(character).set({ [req.field]: req.value, updatedAt: now }).where(eq(character.memberId, req.memberId)).run();
    const players = { ...state.players, [req.memberId]: { ...player, [req.field]: req.value } };
    savePhaseState(tx, gm.gameId, { ...state, players }, now);
    return logOverride(tx, gm, { kind: 'adjust', at: pointOf(state), target: `${req.memberId}.${req.field}`, before, after: req.value, reason: req.reason }, now);
  });
  return ok(overrideLog(db, gm.gameId).find((o) => o.id === id)!);
}

// --- A new event (C4) ---

export function insertEvent(db: Db, gm: MemberRow, input: unknown, now: number): ConsoleResult<GmTimelineEvent> {
  const parsed = GmInsertEventRequest.safeParse(input ?? {});
  if (!parsed.success) return invalid(fieldsOf(parsed.error));
  const req = parsed.data;
  const scenario = getGameScenario(db, gm.gameId);
  if (!scenario) return notAllowed('เกมนี้ไม่มี scenario');
  if (req.day < 1 || req.day > SCENARIO_DAYS) return invalid({ day: `วันต้องอยู่ระหว่าง 1 ถึง ${SCENARIO_DAYS}` });
  if (req.locationId !== null && !scenario.locations.some((l) => l.id === req.locationId)) return invalid({ locationId: 'ไม่มีสถานที่นี้ในเกม' });
  const at = timelinePoint(db, gm.gameId);
  if (at?.ended) return notAllowed('เกมจบเส้นเวลาแล้ว เพิ่มเหตุการณ์ไม่ได้');
  if (at && isBefore(req, at)) return invalid({ day: 'วันและช่วงเวลานี้ผ่านไปแล้ว เพิ่มได้ตั้งแต่ช่วงปัจจุบันเป็นต้นไป' });

  const ids = new Set(scenario.timeline.map((e) => e.id));
  let n = 1;
  while (ids.has(`gm-${n}`)) n++;
  const event: Scenario['timeline'][number] = {
    id: `gm-${n}`,
    day: req.day,
    phase: req.phase,
    // GEN-071 fields: a GM-inserted event is one period, with no foreshadowing or strategies.
    endPhase: null,
    kind: 'event',
    title: req.title,
    description: req.description,
    outcome: req.outcome,
    interventionEffects: '',
    foreshadowing: '',
    foreshadowAt: null,
    strategyIds: [],
    crisis: false,
    locationId: req.locationId,
    npcIds: [],
    gmNote: '',
  };
  const state = ensurePhaseState(db, gm.gameId, now);
  const result = db.transaction((tx) => {
    const updated = updateGameScenario(tx, gm.gameId, { ...scenario, timeline: [...scenario.timeline, event] }, now);
    if (!updated.ok) return updated;
    activateCurrentEvent(tx, gm.gameId, event.id, now);
    const after = { day: event.day, phase: event.phase, title: event.title, description: event.description, outcome: event.outcome, locationId: event.locationId };
    logOverride(tx, gm, { kind: 'event', at: pointOf(state), target: `event:${event.id}`, before: null, after, reason: req.reason }, now);
    return updated;
  });
  if (!result.ok) {
    return result.code === 'invalid' ? invalid(Object.fromEntries(result.errors.map((e) => [e.path, e.message]))) : notAllowed('เกมนี้ไม่มี scenario');
  }
  return ok(timelineEvents(db, gm.gameId).find((e) => e.id === event.id)!);
}
