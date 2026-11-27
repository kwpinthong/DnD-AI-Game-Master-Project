import { nameKey, ONLINE_MAX_PLAYERS, type JoinRequest, type Member } from '@isekai/protocol';
import { and, count, eq, isNull, lte } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { game, lateJoin, member, pinFailure, session } from '../db/schema.ts';
import { lateJoinCheck } from '../game/late-join.ts';
import { hashPin, verifyPin } from './pin.ts';

const MINUTE = 60_000;

/** 5 wrong PINs in a row within 10 minutes lock the name for 10 minutes (C4). */
export const LOCKOUT = { maxFailures: 5, windowMs: 10 * MINUTE, lockMs: 10 * MINUTE } as const;
export const SESSION_TTL_MS = 30 * 24 * 60 * MINUTE;
const SESSION_RENEW_MS = 60 * MINUTE;

export type Clock = () => number;

export type JoinOutcome =
  | { kind: 'joined'; created: boolean; member: Member; token: string; expiresAt: number }
  | { kind: 'game_not_found' }
  | { kind: 'game_full'; mode: 'online' | 'single'; max: number }
  | { kind: 'single_mode' }
  | { kind: 'game_ended' }
  | { kind: 'join_closed_day' }
  | { kind: 'kicked' }
  | { kind: 'wrong_pin'; attemptsLeft: number }
  | { kind: 'locked'; retryAt: number };

type MemberRow = typeof member.$inferSelect;

/** Online games hold 6 players and Single games 1; a Human GM takes no player slot. */
const maxPlayers = (mode: 'online' | 'single') => (mode === 'single' ? 1 : ONLINE_MAX_PLAYERS);

const toMember = (row: MemberRow): Member => ({ id: row.id, gameId: row.gameId, name: row.name });

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * First join with a name creates the member (refused when the game is full; after the start, by the ISK-015
 * late-join rules); later joins need the same PIN and still work after the start. A kicked member's name is blocked.
 */
export async function joinGame(db: Db, input: JoinRequest, now: Clock): Promise<JoinOutcome> {
  const found = db.select().from(game).where(eq(game.inviteCode, input.inviteCode)).get();
  if (!found) return { kind: 'game_not_found' };

  const key = nameKey(input.name);
  const findMember = () =>
    db.select().from(member).where(and(eq(member.gameId, found.id), eq(member.nameKey, key))).get();

  const existing = findMember();
  if (existing) return joinExisting(db, existing, input.pin, now);
  // ISK-023: a name kicked in an earlier round of the room stays blocked (as in its own round: kicked only after a right PIN).
  const kicked = kickedEarlier(db, found.previousGameId, key);
  if (kicked) return joinExisting(db, kicked, input.pin, now);

  if (found.startedAt !== null) {
    const late = lateJoinCheck(db, found);
    if (late.kind !== 'ok') return late;
  }
  const pinHash = await hashPin(input.pin);
  const createdAt = now();
  const row: MemberRow = {
    id: randomUUID(),
    gameId: found.id,
    name: input.name,
    nameKey: key,
    pinHash,
    lockedUntil: null,
    role: 'player',
    kickedAt: null,
    readyAt: null,
    rematchReadyAt: null,
    createdAt,
  };
  try {
    // Re-read inside one transaction: the game may have started or filled up while scrypt ran.
    const refused = db.transaction((tx): JoinOutcome | undefined => {
      const current = tx.select().from(game).where(eq(game.id, found.id)).get();
      if (!current) return { kind: 'game_not_found' };
      // ISK-015: a started game takes newcomers (same seat count; the late-join rules re-read here).
      const late = current.startedAt === null ? null : lateJoinCheck(tx, current);
      if (late !== null && late.kind !== 'ok') return late;
      const players =
        tx
          .select({ n: count() })
          .from(member)
          .where(and(eq(member.gameId, found.id), eq(member.role, 'player'), isNull(member.kickedAt)))
          .get()?.n ?? 0;
      const max = maxPlayers(current.mode);
      if (players >= max) return { kind: 'game_full', mode: current.mode, max };
      tx.insert(member).values(row).run();
      if (late !== null) tx.insert(lateJoin).values({ memberId: row.id, gameId: found.id, joinedTurn: late.turn, spawnedTurn: null }).run();
      return undefined;
    });
    if (refused) return refused;
  } catch (error) {
    // Two first joins with the same name raced; the other one won, so this is now a returning join.
    const winner = isUniqueViolation(error) ? findMember() : undefined;
    if (!winner) throw error;
    return joinExisting(db, winner, input.pin, now);
  }
  return { kind: 'joined', created: true, member: toMember(row), ...openSession(db, row.id, createdAt) };
}

/** The kicked member with this name key in the rounds before (walking `previousGameId` back), if any. */
function kickedEarlier(db: Db, previousGameId: string | null, key: string): MemberRow | undefined {
  for (let id = previousGameId; id !== null; ) {
    const row = db.select().from(member).where(and(eq(member.gameId, id), eq(member.nameKey, key))).get();
    if (row?.kickedAt != null) return row;
    id = db.select({ previous: game.previousGameId }).from(game).where(eq(game.id, id)).get()?.previous ?? null;
  }
  return undefined;
}

async function joinExisting(db: Db, row: MemberRow, pin: string, now: Clock): Promise<JoinOutcome> {
  if (row.lockedUntil !== null && now() < row.lockedUntil) return { kind: 'locked', retryAt: row.lockedUntil };

  const pinMatches = await verifyPin(pin, row.pinHash);

  // Re-read inside one transaction: another request may have locked the name while scrypt ran.
  return db.transaction((tx) => {
    const t = now();
    const current = tx.select({ lockedUntil: member.lockedUntil }).from(member).where(eq(member.id, row.id)).get();
    if (current?.lockedUntil != null && t < current.lockedUntil) return { kind: 'locked', retryAt: current.lockedUntil };

    if (pinMatches) {
      // Checked only after a right PIN, so a guess does not learn who was kicked.
      if (row.kickedAt !== null) return { kind: 'kicked' };
      tx.delete(pinFailure).where(eq(pinFailure.memberId, row.id)).run();
      tx.update(member).set({ lockedUntil: null }).where(eq(member.id, row.id)).run();
      return { kind: 'joined', created: false, member: toMember(row), ...openSession(tx, row.id, t) };
    }

    tx.insert(pinFailure).values({ memberId: row.id, at: t }).run();
    tx.delete(pinFailure)
      .where(and(eq(pinFailure.memberId, row.id), lte(pinFailure.at, t - LOCKOUT.windowMs)))
      .run();
    const failures = tx.select({ n: count() }).from(pinFailure).where(eq(pinFailure.memberId, row.id)).get()?.n ?? 0;
    if (failures >= LOCKOUT.maxFailures) {
      tx.update(member).set({ lockedUntil: t + LOCKOUT.lockMs }).where(eq(member.id, row.id)).run();
      tx.delete(pinFailure).where(eq(pinFailure.memberId, row.id)).run();
    }
    return { kind: 'wrong_pin', attemptsLeft: Math.max(0, LOCKOUT.maxFailures - failures) };
  });
}

export function openSession(db: Pick<Db, 'insert'>, memberId: string, t: number) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = t + SESSION_TTL_MS;
  db.insert(session).values({ tokenHash: hashToken(token), memberId, createdAt: t, expiresAt }).run();
  return { token, expiresAt };
}

/** The member a bearer token belongs to, or undefined when it is unknown, expired or kicked. */
export function memberForToken(db: Db, token: string, now: Clock): Member | undefined {
  const row = memberRowForToken(db, token, now);
  return row && toMember(row);
}

export function memberRowForToken(db: Db, token: string, now: Clock): MemberRow | undefined {
  const tokenHash = hashToken(token);
  const row = db
    .select({ member, expiresAt: session.expiresAt })
    .from(session)
    .innerJoin(member, eq(member.id, session.memberId))
    .where(eq(session.tokenHash, tokenHash))
    .get();
  if (!row) return undefined;
  const t = now();
  if (t >= row.expiresAt) {
    db.delete(session).where(eq(session.tokenHash, tokenHash)).run();
    return undefined;
  }
  if (row.member.kickedAt !== null) return undefined;
  // ISK-021: sliding 30 days from the last use, written at most once an hour per session.
  if (t + SESSION_TTL_MS - row.expiresAt >= SESSION_RENEW_MS) {
    db.update(session).set({ expiresAt: t + SESSION_TTL_MS }).where(eq(session.tokenHash, tokenHash)).run();
  }
  return row.member;
}

export function endSession(db: Db, token: string) {
  db.delete(session).where(eq(session.tokenHash, hashToken(token))).run();
}

/** Drizzle wraps driver errors (DrizzleQueryError), so look through `cause` too. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e = error as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}
