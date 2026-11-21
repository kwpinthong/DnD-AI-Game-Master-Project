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
  let failures: number[] = [];
  let blockedUntil = 0;

  return async function check(code: string): Promise<CreateCodeCheck> {
    if (!hash) return { kind: 'disabled' };
    if (now() < blockedUntil) return { kind: 'blocked', retryAt: blockedUntil };

    if (await verifySecret(code, hash)) return { kind: 'ok' };

    const t = now();
    failures = failures.filter((at) => at > t - CREATE_CODE_LIMIT.windowMs);
    failures.push(t);
    if (failures.length >= CREATE_CODE_LIMIT.maxFailures) {
      blockedUntil = t + CREATE_CODE_LIMIT.lockMs;
      failures = [];
    }
    return { kind: 'wrong' };
  };
}
