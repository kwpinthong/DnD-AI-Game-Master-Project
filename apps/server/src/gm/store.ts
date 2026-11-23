import type { GmFallbackCause } from '@isekai/protocol';
import { PERIODS, type Period, type Turn } from '@isekai/rules';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { PromptBlock } from '../ai/provider.ts';
import type { DbOrTx } from '../db/client.ts';
import { gmConstraint, gmJournal, gmMemory, gmTurn, roomEntry, roomEntryRecipient } from '../db/schema.ts';
import type { DialogueContext } from './context.ts';
import type { GmNarration, GmTurnProposal } from './schema.ts';

/** Rows of the AI GM turn loop (GEN-057). GM-only data: nothing here is sent to a player. */

export interface TurnAt {
  readonly day: number;
  readonly phase: Period;
  readonly turn: Turn;
}

/** A narration as stored for its audience; `fallback` = the server template and why (Q-177), kept across a restart. */
export type StoredNarration = GmNarration & { fallback?: GmFallbackCause };

export interface StoredTurn {
  status: 'adjudicated' | 'applied';
  proposal: GmTurnProposal;
  rolls: number[];
  narrations: Record<string, StoredNarration>;
}

const turnKey = (gameId: string, at: TurnAt) =>
  and(eq(gmTurn.gameId, gameId), eq(gmTurn.day, at.day), eq(gmTurn.phase, at.phase), eq(gmTurn.turn, at.turn));

export function getStoredTurn(db: DbOrTx, gameId: string, at: TurnAt): StoredTurn | null {
  const row = db.select().from(gmTurn).where(turnKey(gameId, at)).get();
  if (!row) return null;
  return {
    status: row.status,
    proposal: JSON.parse(row.proposal) as GmTurnProposal,
    rolls: JSON.parse(row.rolls) as number[],
    narrations: JSON.parse(row.narrations) as Record<string, StoredNarration>,
  };
}

/** Stores the validated proposal and the turn's dice (C6: a restart reuses both). */
export function saveAdjudicated(db: DbOrTx, gameId: string, at: TurnAt, proposal: GmTurnProposal, rolls: readonly number[], now: number): void {
  const values = { status: 'adjudicated' as const, proposal: JSON.stringify(proposal), rolls: JSON.stringify(rolls), narrations: '{}', updatedAt: now };
  db.insert(gmTurn)
    .values({ gameId, ...at, ...values })
    .onConflictDoUpdate({ target: [gmTurn.gameId, gmTurn.day, gmTurn.phase, gmTurn.turn], set: values })
    .run();
}

export function saveNarration(db: DbOrTx, gameId: string, at: TurnAt, key: string, narration: StoredNarration, now: number): void {
  const stored = getStoredTurn(db, gameId, at);
  if (!stored) return;
  db.update(gmTurn)
    .set({ narrations: JSON.stringify({ ...stored.narrations, [key]: narration }), updatedAt: now })
    .where(turnKey(gameId, at))
    .run();
}

export function markApplied(db: DbOrTx, gameId: string, at: TurnAt, now: number): void {
  db.update(gmTurn).set({ status: 'applied', updatedAt: now }).where(turnKey(gameId, at)).run();
}

// --- GEN-128: the dialogue calls of a published turn, kept until their lines are stored ---

/** One audience's dialogue call: all it needs to be asked again after a restart. */
export interface DialogueJob {
  key: string;
  system: PromptBlock[];
  context: DialogueContext;
  forbidden: string[];
}

export function saveDialogueJobs(db: DbOrTx, gameId: string, at: TurnAt, jobs: readonly DialogueJob[], now: number): void {
  db.update(gmTurn).set({ dialogue: jobs.length > 0 ? JSON.stringify(jobs) : null, updatedAt: now }).where(turnKey(gameId, at)).run();
}

export function dialogueJobDone(db: DbOrTx, gameId: string, at: TurnAt, key: string, now: number): void {
  const row = db.select({ dialogue: gmTurn.dialogue }).from(gmTurn).where(turnKey(gameId, at)).get();
  if (!row?.dialogue) return;
  saveDialogueJobs(db, gameId, at, (JSON.parse(row.dialogue) as DialogueJob[]).filter((j) => j.key !== key), now);
}

/** The turns of a game with dialogue calls left, oldest first. */
export function dialogueJobsLeft(db: DbOrTx, gameId: string): { at: TurnAt; jobs: DialogueJob[] }[] {
  return db
    .select()
    .from(gmTurn)
    .where(and(eq(gmTurn.gameId, gameId), isNotNull(gmTurn.dialogue)))
    .all()
    .map((r) => ({ at: { day: r.day, phase: r.phase, turn: r.turn === 2 ? 2 : 1 } as TurnAt, jobs: JSON.parse(r.dialogue!) as DialogueJob[] }))
    .sort((a, b) => a.at.day - b.at.day || PERIODS.indexOf(a.at.phase) - PERIODS.indexOf(b.at.phase) || a.at.turn - b.at.turn);
}

// --- Constraint Lock (C4) ---

export type ConstraintRow = typeof gmConstraint.$inferSelect;

export function activeConstraints(db: DbOrTx, gameId: string): ConstraintRow[] {
  return db
    .select()
    .from(gmConstraint)
    .where(and(eq(gmConstraint.gameId, gameId), isNull(gmConstraint.releasedDay)))
    .orderBy(asc(gmConstraint.id))
    .all();
}

export function addConstraint(db: DbOrTx, c: { gameId: string; memberId: string; text: string; reason: string; day: number }, now: number): void {
  db.insert(gmConstraint).values({ ...c, createdAt: now }).run();
}

export function releaseConstraint(db: DbOrTx, gameId: string, id: number, reason: string, day: number): void {
  db.update(gmConstraint)
    .set({ releasedDay: day, releaseReason: reason })
    .where(and(eq(gmConstraint.gameId, gameId), eq(gmConstraint.id, id)))
    .run();
}

// --- Memory (C5) ---

/**
 * The GM's log of one day from its stored turns: what each actor did and the GM's own notes, in turn order. GEN-190: an
 * adjudicated turn counts too (its proposal never changes after it is stored; only the day's last turn is read that early).
 */
export function dayLog(db: DbOrTx, gameId: string, day: number, before?: TurnAt): string[] {
  const rank = (phase: string, turn: number) => PERIODS.indexOf(phase as Period) * 2 + turn;
  const limit = before ? rank(before.phase, before.turn) : Number.POSITIVE_INFINITY;
  return db
    .select()
    .from(gmTurn)
    .where(and(eq(gmTurn.gameId, gameId), eq(gmTurn.day, day)))
    .all()
    .filter((r) => rank(r.phase, r.turn) < limit)
    .sort((a, b) => rank(a.phase, a.turn) - rank(b.phase, b.turn))
    .flatMap((r) => {
      const p = JSON.parse(r.proposal) as GmTurnProposal;
      const head = `${r.phase} เทิร์น ${r.turn}`;
      return [...p.actions.map((a) => `${head}: ${a.intentSummary}`), ...p.remember.map((n) => `${head} (บันทึก GM): ${n}`)];
    });
}

/** Saga through the day before yesterday and yesterday's recap, for `day`. */
export function memoryFor(db: DbOrTx, gameId: string, day: number): { saga: string | null; yesterday: string | null } {
  const yesterday = db
    .select({ text: gmMemory.text })
    .from(gmMemory)
    .where(and(eq(gmMemory.gameId, gameId), eq(gmMemory.kind, 'day'), eq(gmMemory.day, day - 1)))
    .get();
  const saga = db
    .select({ text: gmMemory.text })
    .from(gmMemory)
    .where(and(eq(gmMemory.gameId, gameId), eq(gmMemory.kind, 'saga'), lte(gmMemory.day, day - 2)))
    .orderBy(desc(gmMemory.day))
    .get();
  return { saga: saga?.text ?? null, yesterday: yesterday?.text ?? null };
}

/** The newest saga (through any day before `day`), as the base for the next one. */
export function latestSaga(db: DbOrTx, gameId: string, beforeDay: number): string | null {
  return (
    db
      .select({ text: gmMemory.text })
      .from(gmMemory)
      .where(and(eq(gmMemory.gameId, gameId), eq(gmMemory.kind, 'saga'), lte(gmMemory.day, beforeDay - 1)))
      .orderBy(desc(gmMemory.day))
      .get()?.text ?? null
  );
}

export function hasDaySummary(db: DbOrTx, gameId: string, day: number): boolean {
  return db.select({ day: gmMemory.day }).from(gmMemory).where(and(eq(gmMemory.gameId, gameId), eq(gmMemory.kind, 'day'), eq(gmMemory.day, day))).get() !== undefined;
}

// --- Player journal (Q-153, ADR §6.3) ---

/** The feed and private narration texts `memberId` received on `day`, oldest first (rendered for them). */
export function seenOnDay(db: DbOrTx, gameId: string, memberId: string, day: number): string[] {
  return db
    .select({ text: roomEntry.text })
    .from(roomEntry)
    .innerJoin(roomEntryRecipient, eq(roomEntryRecipient.entryId, roomEntry.id))
    .where(and(eq(roomEntry.gameId, gameId), eq(roomEntryRecipient.memberId, memberId), eq(roomEntry.day, day), inArray(roomEntry.kind, ['feed', 'narration'])))
    .orderBy(asc(roomEntry.id))
    .all()
    .map((r) => r.text);
}

export function hasJournal(db: DbOrTx, memberId: string, day: number): boolean {
  return db.select({ day: gmJournal.day }).from(gmJournal).where(and(eq(gmJournal.memberId, memberId), eq(gmJournal.kind, 'day'), eq(gmJournal.day, day))).get() !== undefined;
}

/** The newest journal saga of `memberId` through a day before `beforeDay`. */
export function latestJournalSaga(db: DbOrTx, memberId: string, beforeDay: number): string | null {
  return (
    db
      .select({ text: gmJournal.text })
      .from(gmJournal)
      .where(and(eq(gmJournal.memberId, memberId), eq(gmJournal.kind, 'saga'), lte(gmJournal.day, beforeDay - 1)))
      .orderBy(desc(gmJournal.day))
      .get()?.text ?? null
  );
}

/** For a narration on `day`: the player's saga through the day before yesterday and yesterday's journal. */
export function journalFor(db: DbOrTx, memberId: string, day: number): { saga: string | null; yesterday: string | null } {
  const yesterday = db
    .select({ text: gmJournal.text })
    .from(gmJournal)
    .where(and(eq(gmJournal.memberId, memberId), eq(gmJournal.kind, 'day'), eq(gmJournal.day, day - 1)))
    .get();
  return { saga: latestJournalSaga(db, memberId, day - 1), yesterday: yesterday?.text ?? null };
}

export function saveJournal(db: DbOrTx, gameId: string, memberId: string, day: number, journal: { journal: string; saga: string }, now: number): void {
  for (const [kind, text] of [['day', journal.journal], ['saga', journal.saga]] as const) {
    db.insert(gmJournal)
      .values({ gameId, memberId, kind, day, text, createdAt: now })
      .onConflictDoUpdate({ target: [gmJournal.memberId, gmJournal.kind, gmJournal.day], set: { text, createdAt: now } })
      .run();
  }
}

export function saveDaySummary(db: DbOrTx, gameId: string, day: number, summary: { recap: string; saga: string }, now: number): void {
  for (const [kind, text] of [['day', summary.recap], ['saga', summary.saga]] as const) {
    db.insert(gmMemory)
      .values({ gameId, kind, day, text, createdAt: now })
      .onConflictDoUpdate({ target: [gmMemory.gameId, gmMemory.kind, gmMemory.day], set: { text, createdAt: now } })
      .run();
  }
}
