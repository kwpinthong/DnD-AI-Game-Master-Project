import type { GameRatingView } from '@isekai/protocol';
import { restorePhaseState } from '@isekai/rules';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { gamePhase, gameRating, phaseAction, rulingVote } from '../db/schema.ts';
import { activeMembers, type MemberRow } from '../game/service.ts';

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

/** sourceRef → how many current members gave it a 👍 (GEN-081 keeps a ruling from this). */
export function thumbsOf(db: DbOrTx, gameId: string): Map<string, number> {
  const members = new Set(activeMembers(db, gameId).map((m) => m.id));
  const rulings = new Set(rulingsOf(db, gameId).map((r) => r.sourceRef));
  const counts = new Map<string, number>();
  for (const vote of db.select().from(rulingVote).where(eq(rulingVote.gameId, gameId)).all()) {
    if (members.has(vote.memberId) && rulings.has(vote.sourceRef)) counts.set(vote.sourceRef, (counts.get(vote.sourceRef) ?? 0) + 1);
  }
  return counts;
}

/**
 * The rating part of the end page for one member. Members = players + the Human GM, not removed (Q-164 /
 * Q-222); the score is the average of who rated (Q-163). `eligible` / `blocker` only report the two
 * numbers here; the learning gate itself is GEN-079.
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
  const thumbs = thumbsOf(db, me.gameId);
  const liked = db
    .select({ sourceRef: rulingVote.sourceRef })
    .from(rulingVote)
    .where(and(eq(rulingVote.gameId, me.gameId), eq(rulingVote.memberId, me.id)))
    .all()
    .map((v) => v.sourceRef)
    .filter((ref) => thumbs.has(ref))
    .sort();
  const enoughRaters = ratings.length > 0 && ratings.length * 2 >= members.size;
  const highEnough = average !== null && average > 8;
  return {
    mine: mine ? { score: mine.score, comment: mine.comment } : null,
    liked,
    thumbs: Object.fromEntries(thumbs),
    average,
    raters: ratings.length,
    members: members.size,
    eligible: enoughRaters && highEnough,
    blocker: !enoughRaters ? 'too_few_raters' : !highEnough ? 'score_too_low' : null,
  };
}

/** One member = one rating: a resend replaces the score and the comment. */
export function saveRating(db: DbOrTx, me: MemberRow, rating: { score: number; comment: string }, now: number): void {
  db.insert(gameRating)
    .values({ gameId: me.gameId, memberId: me.id, ...rating, updatedAt: now })
    .onConflictDoUpdate({ target: [gameRating.gameId, gameRating.memberId], set: { ...rating, updatedAt: now } })
    .run();
}

/** Turns the member's 👍 on a ruling on or off (both idempotent). False = `sourceRef` is not a ruling of their game. */
export function setLike(db: DbOrTx, me: MemberRow, sourceRef: string, on: boolean, now: number): boolean {
  if (!rulingsOf(db, me.gameId).some((r) => r.sourceRef === sourceRef)) return false;
  if (on) {
    db.insert(rulingVote).values({ gameId: me.gameId, memberId: me.id, sourceRef, createdAt: now }).onConflictDoNothing().run();
  } else {
    db.delete(rulingVote)
      .where(and(eq(rulingVote.gameId, me.gameId), eq(rulingVote.memberId, me.id), eq(rulingVote.sourceRef, sourceRef)))
      .run();
  }
  return true;
}
