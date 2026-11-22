import type { ActionVisibility, RoomEntryKind } from '@isekai/protocol';
import { createPhaseState, type PhasePoint, type PhaseState } from '@isekai/rules';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character, gamePhase, phaseAction, roomEntry, roomEntryRecipient } from '../db/schema.ts';
import { activeMembers } from '../game/service.ts';

/** The game's day / phase engine state; made on first use after the start from the players' characters. */
export function ensurePhaseState(db: DbOrTx, gameId: string, now: number): PhaseState {
  const row = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get();
  if (row) return JSON.parse(row.state) as PhaseState;

  const players = activeMembers(db, gameId).filter((m) => m.role === 'player');
  const stats = new Map(
    players.length === 0
      ? []
      : db
          .select({ memberId: character.memberId, hp: character.hp, stamina: character.stamina })
          .from(character)
          .where(inArray(character.memberId, players.map((m) => m.id)))
          .all()
          .map((c) => [c.memberId, c]),
  );
  // Seat order = join order; a player without a character has no seat (they cannot enter the room, C2).
  const state = createPhaseState({
    players: players.flatMap((m) => {
      const c = stats.get(m.id);
      return c ? [{ id: m.id, hp: c.hp, stamina: c.stamina }] : [];
    }),
  });
  db.insert(gamePhase).values({ gameId, state: JSON.stringify(state), updatedAt: now }).run();
  return state;
}

export function savePhaseState(db: DbOrTx, gameId: string, state: PhaseState, now: number): void {
  db.update(gamePhase).set({ state: JSON.stringify(state), updatedAt: now }).where(eq(gamePhase.gameId, gameId)).run();
}

/** Keeps the action that stands for (game, phase, member); a resubmit replaces it. */
export function recordAction(
  db: DbOrTx,
  gameId: string,
  at: PhasePoint,
  memberId: string,
  action: { text: string; visibility: ActionVisibility },
  now: number,
): void {
  const row = { gameId, day: at.day, phase: at.phase, memberId, ...action, submittedAt: now };
  db.insert(phaseAction)
    .values(row)
    .onConflictDoUpdate({
      target: [phaseAction.gameId, phaseAction.day, phaseAction.phase, phaseAction.memberId],
      set: { text: row.text, visibility: row.visibility, submittedAt: now },
    })
    .run();
}

/** HP / Stamina the engine settled on go back to the character (the visibility layer reads injury from it). */
export function syncCharacterStats(db: DbOrTx, state: PhaseState, now: number): void {
  for (const id of state.order) {
    const p = state.players[id]!;
    db.update(character).set({ hp: p.hp, stamina: p.stamina, updatedAt: now }).where(eq(character.memberId, id)).run();
  }
}

export type RoomEntryRow = typeof roomEntry.$inferSelect;

export interface NewEntry {
  readonly kind: RoomEntryKind;
  readonly at: PhasePoint;
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
