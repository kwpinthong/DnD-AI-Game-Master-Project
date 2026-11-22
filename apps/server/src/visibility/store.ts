import { revealsNpcName, type NpcGrade } from '@isekai/rules';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client.ts';
import { character, characterPresence, knownName, member, npcBond } from '../db/schema.ts';

/**
 * The state the visibility layer reads (GEN-050): where each character is, whose real name each
 * character knows, and each player's bond with each NPC. The engine / later tasks write it through
 * these functions (movement and introductions: GEN-060; affinity changes: GEN-054).
 */

export type PresenceRow = typeof characterPresence.$inferSelect;

const newRef = () => randomBytes(12).toString('base64url');

/**
 * Places every character of the game that has no place yet at `locationId` (the game start).
 * Idempotent: placed characters stay where they are.
 */
export function placeUnplacedCharacters(db: DbOrTx, gameId: string, locationId: string, now: number): void {
  const rows = db
    .select({ memberId: character.memberId })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt)))
    .all();
  for (const { memberId } of rows) {
    db.insert(characterPresence)
      .values({ memberId, gameId, ref: newRef(), locationId, updatedAt: now })
      .onConflictDoNothing()
      .run();
  }
}

/** Moves a placed character. Returns false when the character has no place yet. */
export function moveCharacter(db: DbOrTx, memberId: string, locationId: string, now: number): boolean {
  const result = db
    .update(characterPresence)
    .set({ locationId, updatedAt: now })
    .where(eq(characterPresence.memberId, memberId))
    .run();
  return result.changes > 0;
}

export function presenceOf(db: DbOrTx, memberId: string): PresenceRow | undefined {
  return db.select().from(characterPresence).where(eq(characterPresence.memberId, memberId)).get();
}

/** Every placed character of the game. */
export function presencesInGame(db: DbOrTx, gameId: string): PresenceRow[] {
  return db.select().from(characterPresence).where(eq(characterPresence.gameId, gameId)).all();
}

/** memberId → locationId of every placed character: the snapshot `witnessesOf` takes at resolve time. */
export function locationSnapshot(db: DbOrTx, gameId: string): Map<string, string> {
  return new Map(presencesInGame(db, gameId).map((p) => [p.memberId, p.locationId]));
}

/** `viewer` learns `subject`'s real name (แนะนำตัว = introduced, สืบรู้ = discovered). Only `viewer` learns it. */
export function learnName(
  db: DbOrTx,
  viewerMemberId: string,
  subjectMemberId: string,
  how: 'introduced' | 'discovered',
  now: number,
): void {
  if (viewerMemberId === subjectMemberId) return;
  db.insert(knownName).values({ viewerMemberId, subjectMemberId, how, learnedAt: now }).onConflictDoNothing().run();
}

/** Member ids whose real name `viewer` knows, among `subjects`. */
export function namesKnownBy(db: DbOrTx, viewerMemberId: string, subjects?: readonly string[]): Set<string> {
  if (subjects && subjects.length === 0) return new Set();
  const where = subjects
    ? and(eq(knownName.viewerMemberId, viewerMemberId), inArray(knownName.subjectMemberId, [...subjects]))
    : eq(knownName.viewerMemberId, viewerMemberId);
  return new Set(db.select({ id: knownName.subjectMemberId }).from(knownName).where(where).all().map((r) => r.id));
}

export type NpcBondRow = typeof npcBond.$inferSelect;

/**
 * Stores a player's affinity with an NPC. `nameRevealed` turns on when the rule says so and never turns
 * off (Rules Spec §8.1). The affinity value itself comes from the engine (GEN-054).
 */
export function setNpcAffinity(
  db: DbOrTx,
  memberId: string,
  npc: { readonly id: string; readonly rank: NpcGrade },
  affinity: number,
  now: number,
): NpcBondRow {
  const existing = db
    .select()
    .from(npcBond)
    .where(and(eq(npcBond.memberId, memberId), eq(npcBond.npcId, npc.id)))
    .get();
  const row: NpcBondRow = {
    memberId,
    npcId: npc.id,
    affinity,
    nameRevealed: (existing?.nameRevealed ?? false) || revealsNpcName(npc.rank, affinity),
    updatedAt: now,
  };
  db.insert(npcBond)
    .values(row)
    .onConflictDoUpdate({
      target: [npcBond.memberId, npcBond.npcId],
      set: { affinity: row.affinity, nameRevealed: row.nameRevealed, updatedAt: now },
    })
    .run();
  return row;
}

export function npcBondsOf(db: DbOrTx, memberId: string): NpcBondRow[] {
  return db.select().from(npcBond).where(eq(npcBond.memberId, memberId)).all();
}
