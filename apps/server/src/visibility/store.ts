import { RELATIONSHIP_MAX, RELATIONSHIP_MIN, revealsNpcName, revealsPlayerName, type Degree, type NpcGrade } from '@isekai/rules';
import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client.ts';
import { character, characterPresence, hiddenEvidence, knownName, member, npcBond, playerBond } from '../db/schema.ts';

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

/**
 * Records that `viewer` learned `subject`'s real name (แนะนำตัว = introduced, สืบรู้ = discovered; GEN-050).
 * A discovered name shows to that viewer for good (Q-134, `namesVisibleTo`); an introduction alone does
 * not since GEN-067 (the row stays as a record). Discovering a name already introduced upgrades the row.
 */
export function learnName(
  db: DbOrTx,
  viewerMemberId: string,
  subjectMemberId: string,
  how: 'introduced' | 'discovered',
  now: number,
): void {
  if (viewerMemberId === subjectMemberId) return;
  const insert = db.insert(knownName).values({ viewerMemberId, subjectMemberId, how, learnedAt: now });
  if (how === 'discovered') {
    insert.onConflictDoUpdate({ target: [knownName.viewerMemberId, knownName.subjectMemberId], set: { how, learnedAt: now } }).run();
  } else insert.onConflictDoNothing().run();
}

/** Members whose real name `viewer` discovered (Q-134); permanent, per viewer. */
function discoveredNamesOf(db: DbOrTx, viewerMemberId: string): string[] {
  return db
    .select({ subject: knownName.subjectMemberId })
    .from(knownName)
    .where(and(eq(knownName.viewerMemberId, viewerMemberId), eq(knownName.how, 'discovered')))
    .all()
    .map((r) => r.subject);
}

// --- Between players (GEN-067) ---

export interface PlayerBond {
  readonly alliance: boolean;
  /** -100..+100 */
  readonly relationship: number;
}

/**
 * Sets the alliance flag and / or the relationship between two players of the same game (the AI GM loop,
 * GEN-057, calls this; no player route does). The pair is unordered: A-B is B-A. Relationship is clamped
 * to -100..+100. Throws when the two are the same member or not in the same game.
 */
export function setPlayerBond(
  db: DbOrTx,
  a: string,
  b: string,
  change: { readonly alliance?: boolean; readonly relationship?: number },
  now: number,
): PlayerBond {
  if (a === b) throw new Error('a player has no bond with themself');
  const games = db.select({ id: member.id, gameId: member.gameId }).from(member).where(inArray(member.id, [a, b])).all();
  const gameId = games[0]?.gameId;
  if (games.length !== 2 || games[1]!.gameId !== gameId || gameId === undefined) throw new Error('both players must be in the same game');

  const [memberLow, memberHigh] = pairKey(a, b);
  const existing = playerBondBetween(db, a, b);
  const bond: PlayerBond = {
    alliance: change.alliance ?? existing?.alliance ?? false,
    relationship: clampRelationship(change.relationship ?? existing?.relationship ?? 0),
  };
  db.insert(playerBond)
    .values({ gameId, memberLow, memberHigh, ...bond, updatedAt: now })
    .onConflictDoUpdate({ target: [playerBond.memberLow, playerBond.memberHigh], set: { ...bond, updatedAt: now } })
    .run();
  return bond;
}

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
const clampRelationship = (value: number) => Math.max(RELATIONSHIP_MIN, Math.min(RELATIONSHIP_MAX, Math.trunc(value)));

export function playerBondBetween(db: DbOrTx, a: string, b: string): PlayerBond | undefined {
  const [low, high] = pairKey(a, b);
  return db
    .select({ alliance: playerBond.alliance, relationship: playerBond.relationship })
    .from(playerBond)
    .where(and(eq(playerBond.memberLow, low), eq(playerBond.memberHigh, high)))
    .get();
}

/** Every bond `memberId` has, keyed by the other member. */
export function playerBondsOf(db: DbOrTx, memberId: string): Map<string, PlayerBond> {
  const rows = db
    .select()
    .from(playerBond)
    .where(or(eq(playerBond.memberLow, memberId), eq(playerBond.memberHigh, memberId)))
    .all();
  return new Map(
    rows.map((r) => [r.memberLow === memberId ? r.memberHigh : r.memberLow, { alliance: r.alliance, relationship: r.relationship }]),
  );
}

/** Allies with relationship > +9 (`revealsPlayerName`): they see each other's real name and may Whisper. */
export function closeAlliesOf(db: DbOrTx, memberId: string): Set<string> {
  return new Set([...playerBondsOf(db, memberId)].filter(([, bond]) => revealsPlayerName(bond)).map(([id]) => id));
}

/** Members whose real name `viewer` sees: close allies (not permanent) plus names they discovered (permanent, Q-134). */
export function namesVisibleTo(db: DbOrTx, viewerMemberId: string): Set<string> {
  return new Set([...closeAlliesOf(db, viewerMemberId), ...discoveredNamesOf(db, viewerMemberId)]);
}

// --- Hidden Evidence (GEN-067) ---

export type HiddenEvidenceRow = typeof hiddenEvidence.$inferSelect;

/** A Secret action at `locationId` on game day `day` leaves one tag there. */
export function leaveHiddenEvidence(
  db: DbOrTx,
  evidence: { readonly gameId: string; readonly locationId: string; readonly day: number; readonly actorMemberId: string },
  now: number,
): void {
  db.insert(hiddenEvidence).values({ ...evidence, createdAt: now }).run();
}

/** What an investigator learns of a tag: that it is there, not who left it (the GM narrates the rest). */
export interface FoundEvidence {
  readonly id: number;
  readonly locationId: string;
  readonly day: number;
}

/**
 * INVESTIGATE at the investigator's place on game day `day`: with a success / crit of the resolution engine
 * (GEN-051, `resolveAction`'s `degree`) they find every tag left there that day by someone else; otherwise
 * nothing. A tag from another day is gone.
 */
export function discoverHiddenEvidence(db: DbOrTx, gameId: string, investigatorMemberId: string, day: number, degree: Degree): FoundEvidence[] {
  if (degree !== 'success' && degree !== 'crit') return [];
  const here = presenceOf(db, investigatorMemberId);
  if (!here || here.gameId !== gameId) return [];
  return db
    .select({ id: hiddenEvidence.id, locationId: hiddenEvidence.locationId, day: hiddenEvidence.day })
    .from(hiddenEvidence)
    .where(
      and(
        eq(hiddenEvidence.gameId, gameId),
        eq(hiddenEvidence.locationId, here.locationId),
        eq(hiddenEvidence.day, day),
        ne(hiddenEvidence.actorMemberId, investigatorMemberId),
      ),
    )
    .orderBy(asc(hiddenEvidence.id))
    .all();
}

/** Every tag of the game, oldest first (the Human GM's view). */
export function hiddenEvidenceInGame(db: DbOrTx, gameId: string): HiddenEvidenceRow[] {
  return db.select().from(hiddenEvidence).where(eq(hiddenEvidence.gameId, gameId)).orderBy(asc(hiddenEvidence.id)).all();
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
