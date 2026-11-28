import type { ActionVisibility, GmFallbackCause, HitView, RollView, RoomEntryKind, TurnChange } from '@isekai/protocol';
import { createPhaseState, phaseStep, restorePhaseState, type PhaseState, type Rng, type TurnPoint } from '@isekai/rules';
import { and, asc, eq, gt, inArray, isNotNull, max, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character, gamePhase, lateJoin, member, phaseAction, roomEntry, roomEntryRecipient } from '../db/schema.ts';
import { activeMembers } from '../game/service.ts';

/** Current karma of each of `ids` from their character (the engine's copy only decides Drowsy, Q-087). */
export function karmaOf(db: DbOrTx, ids: readonly string[]): Map<string, number> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ memberId: character.memberId, karma: character.karma })
      .from(character)
      .where(inArray(character.memberId, [...ids]))
      .all()
      .map((c) => [c.memberId, c.karma]),
  );
}

/**
 * The game's day / period / turn engine state; made on first use after the start from the players'
 * characters. A state stored before GEN-063 is read through `restorePhaseState` (C8).
 */
export function ensurePhaseState(db: DbOrTx, gameId: string, now: number): PhaseState {
  const row = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get();
  if (row) return withCharacterHpMax(db, restorePhaseState(JSON.parse(row.state)));

  // ISK-015: a late joiner is never seated here; they take a seat at the turn after they spawn (seatArrivals).
  const late = new Set(db.select({ id: lateJoin.memberId }).from(lateJoin).where(eq(lateJoin.gameId, gameId)).all().map((r) => r.id));
  const players = activeMembers(db, gameId).filter((m) => m.role === 'player' && !late.has(m.id));
  const stats = new Map(
    players.length === 0
      ? []
      : db
          .select({ memberId: character.memberId, hp: character.hp, hpMax: character.hpMax, stamina: character.stamina, karma: character.karma })
          .from(character)
          .where(inArray(character.memberId, players.map((m) => m.id)))
          .all()
          .map((c) => [c.memberId, c]),
  );
  // Seat order = join order; a player without a character has no seat (they cannot enter the room, C2).
  const state = createPhaseState({
    players: players.flatMap((m) => {
      const c = stats.get(m.id);
      return c ? [{ id: m.id, hp: c.hp, hpMax: c.hpMax, stamina: c.stamina, karma: c.karma }] : [];
    }),
  });
  db.insert(gamePhase).values({ gameId, state: JSON.stringify(state), updatedAt: now }).run();
  return state;
}

/** A state saved before the per-player Max HP (Q-210) takes each player's from their character. */
function withCharacterHpMax(db: DbOrTx, state: PhaseState): PhaseState {
  const missing = state.order.filter((id) => state.players[id]!.hpMax === undefined);
  if (missing.length === 0) return state;
  const caps = new Map(
    db.select({ memberId: character.memberId, hpMax: character.hpMax }).from(character).where(inArray(character.memberId, missing)).all().map((c) => [c.memberId, c.hpMax]),
  );
  const players = { ...state.players };
  for (const id of missing) {
    const hpMax = caps.get(id);
    if (hpMax !== undefined) players[id] = { ...players[id]!, hpMax };
  }
  return { ...state, players };
}

/** ISK-018: `state` without the seats of kicked members (a collecting turn may close by it); the same object when none. */
export function withoutKicked(db: DbOrTx, gameId: string, state: PhaseState, rng: Rng): PhaseState {
  if (state.order.length === 0) return state;
  const kicked = db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.gameId, gameId), isNotNull(member.kickedAt), inArray(member.id, [...state.order])))
    .all();
  let next = state;
  for (const { id } of kicked) {
    const step = phaseStep(next, { type: 'leave', playerId: id }, rng);
    if (step.ok) next = step.state;
  }
  return next;
}

export function savePhaseState(db: DbOrTx, gameId: string, state: PhaseState, now: number): void {
  db.update(gamePhase).set({ state: JSON.stringify(state), updatedAt: now }).where(eq(gamePhase.gameId, gameId)).run();
}

/** Keeps the action that stands for (game, turn, member); a resubmit replaces it. */
export function recordAction(
  db: DbOrTx,
  gameId: string,
  at: TurnPoint,
  memberId: string,
  action: { text: string; visibility: ActionVisibility; rest: boolean },
  now: number,
): void {
  // GEN-078 (Q-263): the next number of this game; the conflict branch below leaves a resubmit's number alone.
  const last = db.select({ seq: max(phaseAction.seq) }).from(phaseAction).where(eq(phaseAction.gameId, gameId)).get();
  const row = { gameId, day: at.day, phase: at.phase, turn: at.turn, memberId, ...action, submittedAt: now, seq: (last?.seq ?? 0) + 1 };
  db.insert(phaseAction)
    .values(row)
    .onConflictDoUpdate({
      target: [phaseAction.gameId, phaseAction.day, phaseAction.phase, phaseAction.turn, phaseAction.memberId],
      set: { text: row.text, visibility: row.visibility, rest: row.rest, submittedAt: now },
    })
    .run();
}

/** HP / Stamina the engine settled on go back to the character (the visibility layer reads injury from it). */
export function syncCharacterStats(db: DbOrTx, state: PhaseState, now: number): void {
  for (const id of state.order) {
    const p = state.players[id]!;
    // HP never goes above the character's own Max HP (the start scenario's, GEN-065), whatever the engine's cap.
    db.update(character)
      .set({ hp: sql`min(${p.hp}, ${character.hpMax})`, stamina: p.stamina, updatedAt: now })
      .where(eq(character.memberId, id))
      .run();
  }
}

export type RoomEntryRow = typeof roomEntry.$inferSelect;

/** What an entry carries besides its text (`room_entry.meta`): `finale` marks the ending told after the last turn. */
export interface EntryMeta {
  readonly roll?: RollView;
  readonly hit?: HitView;
  /** GEN-114: a `changes` entry's list (own values that changed in a turn, with reasons). */
  readonly changes?: readonly TurnChange[];
  readonly finale?: true;
  /** GEN-110: an `npc` entry's speaker (scenario NPC id; the viewer's name / ref come at read time) and kind. */
  /** GEN-129: a `player` entry's actor (member id; the viewer's alias / name comes at read time). */
  readonly actor?: string;
  /** ISK-098: `chat` = a reply of the NPC chat (GEN-149), not a line of the turn. */
  readonly npc?: { readonly id: string; readonly kind: 'dialogue' | 'reaction'; readonly private?: true; readonly chat?: true };
  /** ISK-013: a `narration` the server wrote for found Hidden Evidence (not AI text, so not votable). */
  readonly clue?: true;
}

/** ISK-013: a stored clue entry (server text): shown as a clue, never votable. */
export const isClueRow = (row: { readonly meta: string | null }) => row.meta !== null && (JSON.parse(row.meta) as EntryMeta).clue === true;

export interface NewEntry {
  readonly kind: RoomEntryKind | 'hit';
  readonly meta?: EntryMeta;
  readonly at: TurnPoint;
  readonly locationId: string | null;
  readonly text: string;
  /** Whisper only (GEN-067). */
  readonly fromMemberId?: string;
  readonly toMemberId?: string;
  /** Q-177: the cause when the text is the server template. */
  readonly fallback?: GmFallbackCause;
}

/** Stores an entry with who may receive it; the recipients never change afterwards. */
export function insertEntry(db: DbOrTx, gameId: string, entry: NewEntry, recipients: readonly string[], now: number): RoomEntryRow {
  const row = db
    .insert(roomEntry)
    .values({
      gameId,
      kind: entry.kind,
      day: entry.at.day,
      phase: entry.at.phase,
      turn: entry.at.turn,
      locationId: entry.locationId,
      text: entry.text,
      fromMemberId: entry.fromMemberId ?? null,
      toMemberId: entry.toMemberId ?? null,
      fallback: entry.fallback ?? null,
      meta: entry.meta ? JSON.stringify(entry.meta) : null,
      createdAt: now,
    })
    .returning()
    .get();
  for (const memberId of new Set(recipients)) db.insert(roomEntryRecipient).values({ entryId: row.id, memberId }).run();
  return row;
}

/** Entries `memberId` may receive with seq > `afterSeq`, oldest first (the reconnect replay, C6). */
export function entriesFor(db: DbOrTx, gameId: string, memberId: string, afterSeq: number): RoomEntryRow[] {
  return db
    .select({ entry: roomEntry })
    .from(roomEntry)
    .innerJoin(roomEntryRecipient, eq(roomEntryRecipient.entryId, roomEntry.id))
    .where(and(eq(roomEntry.gameId, gameId), eq(roomEntryRecipient.memberId, memberId), gt(roomEntry.id, afterSeq)))
    .orderBy(asc(roomEntry.id))
    .all()
    .map((r) => r.entry);
}
