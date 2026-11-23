import type { EntryVote, GameRatingView } from '@isekai/protocol';
import { restorePhaseState } from '@isekai/rules';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { gamePhase, gameRating, phaseAction, responseVote } from '../db/schema.ts';
import { activeMembers, type MemberRow } from '../game/service.ts';
import { voteFlags } from '../room/vote.ts';

const PERIOD_ORDER = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

/** One action → result row of the end page: an action that stood, which a 👍 may name by `sourceRef`. */
export interface Ruling {
  /** `${day}-${phase}-${turn}-${actionSeq}` (ADR GEN-077); actionSeq = `phase_action.seq`, the action's number in its game (Q-263). */
  sourceRef: string;
  memberId: string;
  day: number;
  phase: (typeof PERIOD_ORDER)[number];
  turn: number;
  visibility: 'public' | 'secret';
  text: string;
}

/** The game reached its end (`finale` or `game_over`); before that nothing here may be written. */
export function gameEnded(db: DbOrTx, gameId: string): boolean {
  const stored = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get();
  if (!stored) return false;
  const { status } = restorePhaseState(JSON.parse(stored.state));
  return status === 'finale' || status === 'game_over';
}

/**
 * Every ruling of the game, oldest first: the actions that stood of the players the end page reveals (not
 * removed ones, never the GM). A removed player's Secret action is not revealed, so it is not a ruling.
 */
export function rulingsOf(db: DbOrTx, gameId: string): Ruling[] {
  const revealed = new Set(activeMembers(db, gameId).filter((m) => m.role === 'player').map((m) => m.id));
  return db
    .select()
    .from(phaseAction)
    .where(eq(phaseAction.gameId, gameId))
    .all()
    .filter((a) => revealed.has(a.memberId))
    .sort((a, b) => a.day - b.day || PERIOD_ORDER.indexOf(a.phase) - PERIOD_ORDER.indexOf(b.phase) || a.turn - b.turn || a.seq - b.seq)
    .map((a) => ({
      sourceRef: `${a.day}-${a.phase}-${a.turn}-${a.seq}`,
      memberId: a.memberId,
      day: a.day,
      phase: a.phase,
      turn: a.turn,
      visibility: a.visibility,
      text: a.text,
    }));
}

/** GEN-171 (Q-325): a ruling's row in response_vote; `ruling_vote` (GEN-078) is no longer read (migration 0038 copied it). */
export const rulingRef = (sourceRef: string) => `ruling-${sourceRef}`;
const RULING_PREFIX = rulingRef('');

/** The member's own votes on rulings that still stand: sourceRef → 👍/👎. */
function myRulingVotes(db: DbOrTx, me: MemberRow): Record<string, EntryVote> {
  const rulings = new Set(rulingsOf(db, me.gameId).map((r) => r.sourceRef));
  const out: Record<string, EntryVote> = {};
  for (const v of db.select().from(responseVote).where(and(eq(responseVote.gameId, me.gameId), eq(responseVote.memberId, me.id))).all()) {
    const ref = v.sourceRef.slice(RULING_PREFIX.length);
    if (v.sourceRef.startsWith(RULING_PREFIX) && rulings.has(ref)) out[ref] = v.vote;
  }
  return out;
}

/** sourceRef → the players' 👍/👎 with the GEN-126 verdict out of the players of the game now (GEN-081 keeps a ruling from this). */
export function rulingVotes(db: DbOrTx, gameId: string): Map<string, { up: number; down: number; good: boolean; avoid: boolean }> {
  const players = new Set(activeMembers(db, gameId).filter((m) => m.role === 'player').map((m) => m.id));
  const rulings = new Set(rulingsOf(db, gameId).map((r) => r.sourceRef));
  const counts = new Map<string, { up: number; down: number }>();
  for (const v of db.select().from(responseVote).where(eq(responseVote.gameId, gameId)).all()) {
    const ref = v.sourceRef.slice(RULING_PREFIX.length);
    if (!v.sourceRef.startsWith(RULING_PREFIX) || !players.has(v.memberId) || !rulings.has(ref)) continue;
    const c = counts.get(ref) ?? { up: 0, down: 0 };
    c[v.vote] += 1;
    counts.set(ref, c);
  }
  return new Map([...counts].map(([ref, c]) => [ref, { ...c, ...voteFlags(c, players.size) }]));
}

/**
 * The rating part of the end page for one member. Members = players + the Human GM, not removed (Q-222);
 * the score is the average of who rated (Q-163), shown only: GEN-079 dropped the > 8 gate (Q-286 / Q-287).
 */
export function ratingViewFor(db: DbOrTx, me: MemberRow): GameRatingView {
  const members = new Set(activeMembers(db, me.gameId).map((m) => m.id));
  const ratings = db
    .select()
    .from(gameRating)
    .where(eq(gameRating.gameId, me.gameId))
    .all()
    .filter((r) => members.has(r.memberId));
  const mine = ratings.find((r) => r.memberId === me.id);
  const average = ratings.length === 0 ? null : ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
  return {
    mine: mine ? { score: mine.score, comment: mine.comment } : null,
    myVotes: myRulingVotes(db, me),
    canVote: me.role === 'player',
    average,
    raters: ratings.length,
    members: members.size,
  };
}

/** One member = one rating: a resend replaces the score and the comment. */
export function saveRating(db: DbOrTx, me: MemberRow, rating: { score: number; comment: string }, now: number): void {
  db.insert(gameRating)
    .values({ gameId: me.gameId, memberId: me.id, ...rating, updatedAt: now })
    .onConflictDoUpdate({ target: [gameRating.gameId, gameRating.memberId], set: { ...rating, updatedAt: now } })
    .run();
}

/** Sets (null = cancels) a player's 👍/👎 on a ruling, idempotent. False = `sourceRef` is not a ruling of their game. */
export function setRulingVote(db: DbOrTx, me: MemberRow, sourceRef: string, vote: EntryVote | null, now: number): boolean {
  if (!rulingsOf(db, me.gameId).some((r) => r.sourceRef === sourceRef)) return false;
  const ref = rulingRef(sourceRef);
  if (vote === null) {
    db.delete(responseVote).where(and(eq(responseVote.gameId, me.gameId), eq(responseVote.memberId, me.id), eq(responseVote.sourceRef, ref))).run();
  } else {
    db.insert(responseVote)
      .values({ gameId: me.gameId, memberId: me.id, sourceRef: ref, vote, updatedAt: now })
      .onConflictDoUpdate({ target: [responseVote.gameId, responseVote.memberId, responseVote.sourceRef], set: { vote, updatedAt: now } })
      .run();
  }
  return true;
}
