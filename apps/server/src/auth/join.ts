import { nameKey, type JoinRequest, type Member } from '@isekai/protocol';
import { and, count, eq, lte } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { game, member, pinFailure, session } from '../db/schema.ts';
import { hashPin, verifyPin } from './pin.ts';

const MINUTE = 60_000;

/** 5 wrong PINs in a row within 10 minutes lock the name for 10 minutes (C4). */
export const LOCKOUT = { maxFailures: 5, windowMs: 10 * MINUTE, lockMs: 10 * MINUTE } as const;
export const SESSION_TTL_MS = 30 * 24 * 60 * MINUTE;

export type Clock = () => number;

export type JoinOutcome =
  | { kind: 'joined'; created: boolean; member: Member; token: string; expiresAt: number }
  | { kind: 'game_not_found' }
  | { kind: 'wrong_pin'; attemptsLeft: number }
  | { kind: 'locked'; retryAt: number };

type MemberRow = typeof member.$inferSelect;

const toMember = (row: MemberRow): Member => ({ id: row.id, gameId: row.gameId, name: row.name });

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** First join with a name creates the member; later joins need the same PIN. */
export async function joinGame(db: Db, input: JoinRequest, now: Clock): Promise<JoinOutcome> {
  const found = db.select({ id: game.id }).from(game).where(eq(game.inviteCode, input.inviteCode)).get();
  if (!found) return { kind: 'game_not_found' };

  const key = nameKey(input.name);
  const findMember = () =>
    db.select().from(member).where(and(eq(member.gameId, found.id), eq(member.nameKey, key))).get();

  const existing = findMember();
  if (existing) return joinExisting(db, existing, input.pin, now);

  const pinHash = await hashPin(input.pin);
  const createdAt = now();
  const row: MemberRow = { id: randomUUID(), gameId: found.id, name: input.name, nameKey: key, pinHash, lockedUntil: null, createdAt };
  try {
    db.insert(member).values(row).run();
  } catch (error) {
    // Two first joins with the same name raced; the other one won, so this is now a returning join.
    const winner = isUniqueViolation(error) ? findMember() : undefined;
    if (!winner) throw error;
    return joinExisting(db, winner, input.pin, now);
  }
  return { kind: 'joined', created: true, member: toMember(row), ...openSession(db, row.id, createdAt) };
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

function openSession(db: Pick<Db, 'insert'>, memberId: string, t: number) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = t + SESSION_TTL_MS;
  db.insert(session).values({ tokenHash: hashToken(token), memberId, createdAt: t, expiresAt }).run();
  return { token, expiresAt };
}

/** The member a bearer token belongs to, or undefined when it is unknown or expired. */
export function memberForToken(db: Db, token: string, now: Clock): Member | undefined {
  const tokenHash = hashToken(token);
  const row = db
    .select({ member, expiresAt: session.expiresAt })
    .from(session)
    .innerJoin(member, eq(member.id, session.memberId))
    .where(eq(session.tokenHash, tokenHash))
    .get();
  if (!row) return undefined;
  if (now() >= row.expiresAt) {
    db.delete(session).where(eq(session.tokenHash, tokenHash)).run();
    return undefined;
  }
  return toMember(row.member);
}

/** Drizzle wraps driver errors (DrizzleQueryError), so look through `cause` too. */
function isUniqueViolation(error: unknown): boolean {
  for (let e = error as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}
