import type { ActionVisibility, RoomEntryKind } from '@isekai/protocol';
import { createPhaseState, restorePhaseState, type PhaseState, type TurnPoint } from '@isekai/rules';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character, gamePhase, phaseAction, roomEntry, roomEntryRecipient } from '../db/schema.ts';
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
  if (row) return restorePhaseState(JSON.parse(row.state));

  const players = activeMembers(db, gameId).filter((m) => m.role === 'player');
  const stats = new Map(
    players.length === 0
      ? []
      : db
          .select({ memberId: character.memberId, hp: character.hp, stamina: character.stamina, karma: character.karma })
          .from(character)
          .where(inArray(character.memberId, players.map((m) => m.id)))
          .all()
          .map((c) => [c.memberId, c]),
  );
  // Seat order = join order; a player without a character has no seat (they cannot enter the room, C2).
  const state = createPhaseState({
    players: players.flatMap((m) => {
      const c = stats.get(m.id);
      return c ? [{ id: m.id, hp: c.hp, stamina: c.stamina, karma: c.karma }] : [];
    }),
  });
  db.insert(gamePhase).values({ gameId, state: JSON.stringify(state), updatedAt: now }).run();
  return state;
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
  const row = { gameId, day: at.day, phase: at.phase, turn: at.turn, memberId, ...action, submittedAt: now };
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

export interface NewEntry {
  readonly kind: RoomEntryKind;
  readonly at: TurnPoint;
  readonly locationId: string | null;
  readonly text: string;
  /** Whisper only (GEN-067). */
  readonly fromMemberId?: string;
  readonly toMemberId?: string;
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
