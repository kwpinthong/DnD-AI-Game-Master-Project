import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../auth/join.ts';

/**
 * The server owner's admin token (GEN-061, Q-058). There is no owner account: the admin code
 * (checked against ADMIN_CODE_HASH) is exchanged for a random token that lasts one hour.
 * Tokens live in memory, keyed by their SHA-256 (the token itself is never kept): one process, one
 * replica, and a restart simply signs the owner out. Nothing here is ever logged.
 */
export const ADMIN_SESSION_TTL_MS = 60 * 60 * 1000;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AdminSessions {
  issue(): { token: string; expiresAt: number };
  valid(token: string | undefined): boolean;
  revoke(token: string | undefined): void;
}

export function createAdminSessions(now: Clock): AdminSessions {
  const sessions = new Map<string, number>();

  const prune = (t: number) => {
    for (const [key, expiresAt] of sessions) if (expiresAt <= t) sessions.delete(key);
  };

  return {
    issue() {
      const t = now();
      prune(t);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = t + ADMIN_SESSION_TTL_MS;
      sessions.set(digest(token), expiresAt);
      return { token, expiresAt };
    },
    valid(token) {
      if (!token) return false;
      const expiresAt = sessions.get(digest(token));
      return expiresAt !== undefined && now() < expiresAt;
    },
    revoke(token) {
      if (token) sessions.delete(digest(token));
    },
  };
}
