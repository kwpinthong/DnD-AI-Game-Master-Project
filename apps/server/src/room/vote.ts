import { isVotableEntry, type EntryVote, type GmVoteEntry, type GmVotesResponse } from '@isekai/protocol';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { responseVote, roomEntry, roomEntryRecipient } from '../db/schema.ts';
import { activeMembers, type MemberRow } from '../game/service.ts';

/** The learning id of an entry's response (the same `sourceRef` idea as GEN-078's rulings). */
export const entryRef = (seq: number) => `entry-${seq}`;

/** The member's vote on one entry; null = none. */
export function myVoteOf(db: DbOrTx, gameId: string, memberId: string, seq: number): EntryVote | null {
  return db
    .select({ vote: responseVote.vote })
    .from(responseVote)
    .where(and(eq(responseVote.gameId, gameId), eq(responseVote.memberId, memberId), eq(responseVote.sourceRef, entryRef(seq))))
    .get()?.vote ?? null;
}

/**
 * GEN-126: Q-286 good example = 👍 > half of all players (a non-voter counts as 👎, a tie does not pass);
 * Q-287 to avoid = real 👎 > half of all players (non-voters do not count).
 */
export function voteVerdict(votes: { up: number; down: number }, players: number): { good: boolean; avoid: boolean } {
  return { good: players > 0 && votes.up * 2 > players, avoid: players > 0 && votes.down * 2 > players };
}

/** GEN-126: every voted entry of the game with its counts out of the players of the game now (only their votes count), oldest first. */
export function gameVotes(db: DbOrTx, gameId: string): GmVotesResponse {
  const players = new Set(activeMembers(db, gameId).filter((m) => m.role === 'player').map((m) => m.id));
  const counts = new Map<string, { up: number; down: number }>();
  for (const v of db.select().from(responseVote).where(eq(responseVote.gameId, gameId)).all()) {
    if (!players.has(v.memberId)) continue;
    const c = counts.get(v.sourceRef) ?? { up: 0, down: 0 };
    c[v.vote] += 1;
    counts.set(v.sourceRef, c);
  }
  const seqs = [...counts.keys()].map((ref) => Number(ref.slice('entry-'.length)));
  const rows = seqs.length === 0 ? [] : db.select().from(roomEntry).where(and(eq(roomEntry.gameId, gameId), inArray(roomEntry.id, seqs))).orderBy(asc(roomEntry.id)).all();
  const entries = rows.map((row): GmVoteEntry => {
    const c = counts.get(entryRef(row.id))!;
    return { seq: row.id, kind: row.kind, at: { day: row.day, phase: row.phase, turn: row.turn === 2 ? 2 : 1 }, text: row.text, ...c, ...voteVerdict(c, players.size) };
  });
  return { players: players.size, entries };
}

export type VoteResult = 'ok' | 'not_found' | 'forbidden';

/**
 * Sets (or with null cancels) a player's vote on an AI-written entry of their game. `forbidden`: not a
 * player, or the entry was not sent to them (a private message of someone else). `not_found`: no such entry
 * in this game, or it is not AI-written (a whisper, an omen, a server template).
 */
export function setVote(db: DbOrTx, me: MemberRow, seq: number, vote: EntryVote | null, now: number): VoteResult {
  const entry = db.select().from(roomEntry).where(and(eq(roomEntry.id, seq), eq(roomEntry.gameId, me.gameId))).get();
  if (!entry) return 'not_found';
  const received = db
    .select({ memberId: roomEntryRecipient.memberId })
    .from(roomEntryRecipient)
    .where(and(eq(roomEntryRecipient.entryId, seq), eq(roomEntryRecipient.memberId, me.id)))
    .get();
  if (me.role !== 'player' || !received) return 'forbidden';
  if (!isVotableEntry(entry)) return 'not_found';
  const ref = entryRef(seq);
  if (vote === null) {
    db.delete(responseVote).where(and(eq(responseVote.gameId, me.gameId), eq(responseVote.memberId, me.id), eq(responseVote.sourceRef, ref))).run();
  } else {
    db.insert(responseVote)
      .values({ gameId: me.gameId, memberId: me.id, sourceRef: ref, vote, updatedAt: now })
      .onConflictDoUpdate({ target: [responseVote.gameId, responseVote.memberId, responseVote.sourceRef], set: { vote, updatedAt: now } })
      .run();
  }
  return 'ok';
}
