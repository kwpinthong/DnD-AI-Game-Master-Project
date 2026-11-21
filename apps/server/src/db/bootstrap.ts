import { normalizeInviteCode } from '@isekai/protocol';
import { randomUUID } from 'node:crypto';
import type { Db } from './client.ts';
import { game } from './schema.ts';

/**
 * Makes sure a game with this invite code exists (BOOTSTRAP_INVITE_CODE), so a fresh deploy can be
 * joined before GEN-025 adds game creation. Safe on every start: an existing code is left alone.
 */
export function ensureGame(db: Db, rawInviteCode: string, now: number): void {
  const inviteCode = normalizeInviteCode(rawInviteCode);
  if (!inviteCode) return;
  db.insert(game).values({ id: randomUUID(), inviteCode, createdAt: now }).onConflictDoNothing({ target: game.inviteCode }).run();
}
