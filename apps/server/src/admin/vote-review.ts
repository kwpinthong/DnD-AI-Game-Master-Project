import { isVotableEntry, VoteReason, type AdminCorrection, type AdminDownvoteEntry, type ReviewScene } from '@isekai/protocol';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character, game, member, responseCorrection, responseVote, roomEntry } from '../db/schema.ts';
import type { EntryMeta, RoomEntryRow } from '../room/store.ts';
import { getGameScenario } from '../scenario/store.ts';

/**
 * GEN-168: the server owner's review of 👎 messages. Reads response_vote (`entry-…` rows) and room_entry; writes
 * only response_correction, never the game's own text.
 */

type CorrectionRow = typeof responseCorrection.$inferSelect;

const sceneOf = (row: RoomEntryRow, meta: EntryMeta): ReviewScene =>
  row.kind === 'npc' ? (meta.npc?.kind === 'reaction' ? 'npc-reaction' : 'npc-dialogue') : row.kind === 'feed' ? 'feed' : 'narration';

const correctionView = (c: CorrectionRow): AdminCorrection => ({
  id: c.id,
  gameId: c.gameId,
  seq: c.entryId,
  original: c.original,
  edited: c.edited,
  npc: c.npcName,
  scene: c.scene,
  reasons: JSON.parse(c.reasons) as VoteReason[],
  libraryCandidate: c.libraryCandidate,
  createdAt: new Date(c.createdAt).toISOString(),
});

function npcOf(db: DbOrTx, row: RoomEntryRow, meta: EntryMeta): { id: string; name: string } | null {
  if (row.kind !== 'npc' || !meta.npc) return null;
  const id = meta.npc.id;
  return { id, name: getGameScenario(db, row.gameId)?.npcs.find((n) => n.id === id)?.name ?? id };
}

/** reason → how many 👎 of the entry named it. */
function reasonCounts(votes: readonly { reasons: string }[]): Partial<Record<VoteReason, number>> {
  const counts: Partial<Record<VoteReason, number>> = {};
  for (const v of votes) for (const r of JSON.parse(v.reasons) as VoteReason[]) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

/** Every AI message with at least one 👎, newest first, with its NPC, reason counts and saved pairs. */
export function downvotedEntries(db: DbOrTx): AdminDownvoteEntry[] {
  const downs = db.select().from(responseVote).where(and(eq(responseVote.vote, 'down'), like(responseVote.sourceRef, 'entry-%'))).all();
  const ids = [...new Set(downs.map((v) => Number(v.sourceRef.slice('entry-'.length))))];
  if (ids.length === 0) return [];
  const rows = db.select().from(roomEntry).where(inArray(roomEntry.id, ids)).all();
  const names = new Map(db.select({ id: game.id, name: game.name }).from(game).all().map((g) => [g.id, g.name]));
  const corrections = db.select().from(responseCorrection).where(inArray(responseCorrection.entryId, ids)).orderBy(asc(responseCorrection.id)).all();
  return rows
    .sort((a, b) => b.id - a.id)
    .map((row) => {
      const meta = row.meta === null ? {} : (JSON.parse(row.meta) as EntryMeta);
      const mine = downs.filter((v) => v.gameId === row.gameId && v.sourceRef === `entry-${row.id}`);
      return {
        gameId: row.gameId,
        gameName: names.get(row.gameId) ?? '',
        seq: row.id,
        scene: sceneOf(row, meta),
        npc: npcOf(db, row, meta),
        at: { day: row.day, phase: row.phase, turn: row.turn === 2 ? 2 : 1 },
        text: row.text,
        down: mine.length,
        reasons: reasonCounts(mine),
        corrections: corrections.filter((c) => c.gameId === row.gameId && c.entryId === row.id).map(correctionView),
      };
    })
    .filter((e) => e.down > 0);
}

/** Each member's real names (lobby name, character name), in join order: index n → `{{PLAYER_n+1}}` in the export. */
function memberNames(db: DbOrTx, gameId: string): string[][] {
  return db
    .select({ name: member.name, character: character.name })
    .from(member)
    .leftJoin(character, eq(character.memberId, member.id))
    .where(eq(member.gameId, gameId))
    // rowid: members of one game often share created_at (the same clock tick); the insert order breaks the tie.
    .orderBy(asc(member.createdAt), sql`member.rowid`)
    .all()
    .map((m) => [m.name, m.character ?? ''].filter((n) => n.trim().length > 0));
}

/**
 * C4 / C5: stores one pair (append-only) for an AI message of the game; null = no such AI message. `toLibrary`
 * only marks the pair as a candidate for GEN-151's NPC example library.
 */
export function saveCorrection(db: DbOrTx, input: { gameId: string; seq: number; edited: string; toLibrary: boolean }, now: number): AdminCorrection | null {
  const row = db.select().from(roomEntry).where(and(eq(roomEntry.id, input.seq), eq(roomEntry.gameId, input.gameId))).get();
  if (!row || !isVotableEntry(row)) return null;
  const meta = row.meta === null ? {} : (JSON.parse(row.meta) as EntryMeta);
  const downs = db.select({ reasons: responseVote.reasons }).from(responseVote).where(and(eq(responseVote.gameId, row.gameId), eq(responseVote.sourceRef, `entry-${row.id}`), eq(responseVote.vote, 'down'))).all();
  const named = new Set(downs.flatMap((v) => JSON.parse(v.reasons) as VoteReason[]));
  const saved = db
    .insert(responseCorrection)
    .values({
      gameId: row.gameId,
      entryId: row.id,
      original: row.text,
      edited: input.edited,
      npcName: npcOf(db, row, meta)?.name ?? null,
      scene: sceneOf(row, meta),
      reasons: JSON.stringify(VoteReason.options.filter((r) => named.has(r))),
      playerNames: JSON.stringify(memberNames(db, row.gameId)),
      libraryCandidate: input.toLibrary,
      createdAt: now,
    })
    .returning()
    .get();
  return correctionView(saved);
}

/** C6: every pair as one JSON line, each player's real names swapped for `{{PLAYER_n}}` (longest name first). */
export function correctionsJsonl(db: DbOrTx): { count: number; jsonl: string } {
  const rows = db.select().from(responseCorrection).orderBy(asc(responseCorrection.id)).all();
  const lines = rows.map((c) => {
    const swaps = (JSON.parse(c.playerNames) as string[][])
      .flatMap((names, i) => names.map((name) => [name, `{{PLAYER_${i + 1}}}`] as const))
      .sort((a, b) => b[0].length - a[0].length);
    const mask = (text: string) => swaps.reduce((out, [name, token]) => out.replaceAll(name, token), text.normalize('NFC'));
    return JSON.stringify({ npc: c.npcName, scene: c.scene, reasons: JSON.parse(c.reasons) as string[], original: mask(c.original), edited: mask(c.edited), libraryCandidate: c.libraryCandidate });
  });
  return { count: lines.length, jsonl: lines.map((l) => `${l}\n`).join('') };
}
