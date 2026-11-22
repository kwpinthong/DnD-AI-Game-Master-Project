import { isVotableEntry, type EntryVote } from '@isekai/protocol';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { responseVote, roomEntry, roomEntryRecipient } from '../db/schema.ts';
import type { MemberRow } from '../game/service.ts';

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
