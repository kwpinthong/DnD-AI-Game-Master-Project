import { verifySecret } from '../auth/pin.ts';
import type { Clock } from '../auth/join.ts';

const MINUTE = 60_000;

/**
 * 10 wrong create codes within 10 minutes block game creation for 10 minutes, for everyone.
 * Server-wide on purpose: the create code is one secret for the whole server, and a per-IP count
 * behind Railway's proxy would trust a forwarded-for header the client can set. The cost is that
 * someone guessing can hold up game creation for the group; nothing else is affected.
 */
export const CREATE_CODE_LIMIT = { maxFailures: 10, windowMs: 10 * MINUTE, lockMs: 10 * MINUTE } as const;

export type CreateCodeCheck = { kind: 'ok' } | { kind: 'disabled' } | { kind: 'wrong' } | { kind: 'blocked'; retryAt: number };

/**
 * Checks create codes against CREATE_CODE_HASH (scrypt, compared with timingSafeEqual).
 * Counts live in memory: one process, one replica; a restart clears them.
 */
export function createCodeChecker(hash: string | undefined, now: Clock) {
  const keyed = createKeyedCodeChecker(hash, now);
  return (code: string): Promise<CreateCodeCheck> => keyed(code, 'server');
}

/** What `createKeyedCodeChecker`'s `onLock` gets: the key that just got locked, and until when. */
export type CodeLockListener = (key: string, until: number) => void;

/**
 * The same limit counted per `key` (Q-170: the admin code, per client IP). One key's failures never
 * lock another key. Keys with nothing left to remember are dropped, so the map stays small.
 */
export function createKeyedCodeChecker(hash: string | undefined, now: Clock, onLock?: CodeLockListener) {
  const state = new Map<string, { failures: number[]; blockedUntil: number }>();

  const prune = (t: number) => {
    for (const [key, s] of state) {
      if (s.blockedUntil <= t && s.failures.every((at) => at <= t - CREATE_CODE_LIMIT.windowMs)) state.delete(key);
    }
  };

  return async function check(code: string, key: string): Promise<CreateCodeCheck> {
    if (!hash) return { kind: 'disabled' };
    const blockedUntil = state.get(key)?.blockedUntil ?? 0;
    if (now() < blockedUntil) return { kind: 'blocked', retryAt: blockedUntil };

    if (await verifySecret(code, hash)) return { kind: 'ok' };

    const t = now();
    prune(t);
    const s = state.get(key) ?? { failures: [], blockedUntil: 0 };
    s.failures = s.failures.filter((at) => at > t - CREATE_CODE_LIMIT.windowMs);
    s.failures.push(t);
    if (s.failures.length >= CREATE_CODE_LIMIT.maxFailures) {
      s.blockedUntil = t + CREATE_CODE_LIMIT.lockMs;
      s.failures = [];
      onLock?.(key, s.blockedUntil);
    }
    state.set(key, s);
    return { kind: 'wrong' };
  };
}
