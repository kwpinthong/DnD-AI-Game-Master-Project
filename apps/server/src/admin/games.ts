import { CLOSE_REASON_MAX, type AdminGameRow, type AdminMemberRow } from '@isekai/protocol';
import { restorePhaseState, type PhaseState, type Rng } from '@isekai/rules';
import { and, asc, eq, sql, sum } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { aiUsage } from '../db/schema-ai.ts';
import { adminGameAudit, character, game, gameClose, gamePhase, member } from '../db/schema.ts';
import { getEnding, markNarrated } from '../finale/store.ts';
import { blockMember, playerCount, renewGameInviteCode } from '../game/service.ts';
import { savePhaseState, withoutKicked } from '../room/store.ts';

/**
 * ISK-001: the server owner's list of every game and the early close. A closed game is a `game_close` row; a game
 * that was being played is also put in the engine's `finale` status, so everything that reads "ended" (end page,
 * rating, votes, learning, locks) treats it like a normal end, with no AI ending.
 */

export interface Closure {
  reason: string | null;
  hasSummary: boolean;
}

/** The stored close of a game; null = not closed. */
export function closureOf(db: DbOrTx, gameId: string): Closure | null {
  return db.select({ reason: gameClose.reason, hasSummary: gameClose.hasSummary }).from(gameClose).where(eq(gameClose.gameId, gameId)).get() ?? null;
}

const isEnded = (state: PhaseState) => state.status === 'finale' || state.status === 'game_over';

function phaseOf(db: DbOrTx, gameId: string): { state: PhaseState; updatedAt: number } | null {
  const row = db.select({ state: gamePhase.state, updatedAt: gamePhase.updatedAt }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get();
  return row ? { state: restorePhaseState(JSON.parse(row.state)), updatedAt: row.updatedAt } : null;
}

/** Ended on its own: finale / game_over with its ending told (an ending still being written can be closed). */
function endedOnItsOwn(db: DbOrTx, gameId: string, state: PhaseState | undefined): boolean {
  return state !== undefined && isEnded(state) && getEnding(db, gameId)?.narrated !== false;
}

function rowOf(db: DbOrTx, g: { id: string; name: string; startedAt: number | null }, costMicros: number): AdminGameRow & { sortAt: number | null } {
  const phase = phaseOf(db, g.id);
  const closed = closureOf(db, g.id) !== null;
  const ended = endedOnItsOwn(db, g.id, phase?.state);
  return {
    id: g.id,
    name: g.name,
    phase: closed || ended ? 'ended' : g.startedAt === null ? 'lobby' : phase === null ? 'setup' : 'playing',
    endedReason: closed ? 'closed' : ended ? (phase!.state.status as 'finale' | 'game_over') : null,
    day: phase?.state.day ?? null,
    period: phase?.state.phase ?? null,
    playerCount: playerCount(db, g.id),
    lastActionAt: phase ? new Date(phase.updatedAt).toISOString() : null,
    aiUsd: costMicros / 1_000_000,
    sortAt: phase?.updatedAt ?? null,
  };
}

/** Every game, newest `lastActionAt` (else created time) first. shortcut: a few queries per game, fine for one owner's server; batch them if the list grows to thousands. */
export function listGames(db: Db): AdminGameRow[] {
  const cost = new Map(
    db
      .select({ gameId: aiUsage.gameId, micros: sum(aiUsage.costUsdMicros).mapWith(Number) })
      .from(aiUsage)
      .groupBy(aiUsage.gameId)
      .all()
      .map((r) => [r.gameId, r.micros] as const),
  );
  return db
    .select({ id: game.id, name: game.name, startedAt: game.startedAt, createdAt: game.createdAt })
    .from(game)
    .all()
    .map((g) => ({ ...rowOf(db, g, cost.get(g.id) ?? 0), createdAt: g.createdAt }))
    .sort((a, b) => (b.sortAt ?? b.createdAt) - (a.sortAt ?? a.createdAt) || b.createdAt - a.createdAt)
    .map(({ sortAt: _s, createdAt: _c, ...row }) => row);
}

/** One game's row (after a close). */
export function gameRow(db: Db, gameId: string): AdminGameRow | null {
  const g = db.select({ id: game.id, name: game.name, startedAt: game.startedAt }).from(game).where(eq(game.id, gameId)).get();
  if (!g) return null;
  const micros = db.select({ micros: sum(aiUsage.costUsdMicros).mapWith(Number) }).from(aiUsage).where(eq(aiUsage.gameId, gameId)).get()?.micros ?? 0;
  const { sortAt: _s, ...row } = rowOf(db, g, micros);
  return row;
}

/** ISK-018: ended for the kick / new code = the same rule as a second close. */
const hasEnded = (db: DbOrTx, gameId: string) => closureOf(db, gameId) !== null || endedOnItsOwn(db, gameId, phaseOf(db, gameId)?.state);
const gameExists = (db: DbOrTx, gameId: string) => db.select({ id: game.id }).from(game).where(eq(game.id, gameId)).get() !== undefined;

/** ISK-018: every member of a game, kicked ones too, join order; null = no such game. `ready` waits for ISK-017. */
export function gameMembers(db: Db, gameId: string): AdminMemberRow[] | null {
  if (!gameExists(db, gameId)) return null;
  return db
    .select({ id: member.id, name: member.name, role: member.role, kickedAt: member.kickedAt, characterOf: character.memberId })
    .from(member)
    .leftJoin(character, eq(character.memberId, member.id))
    .where(eq(member.gameId, gameId))
    .orderBy(asc(member.createdAt), sql`"member".rowid`)
    .all()
    .map((m) => ({ id: m.id, name: m.name, role: m.role, hasCharacter: m.characterOf !== null, ready: false, kickedAt: m.kickedAt === null ? null : new Date(m.kickedAt).toISOString() }));
}

export type KickOutcome =
  | { kind: 'game_not_found' }
  | { kind: 'member_not_found' }
  | { kind: 'already_kicked' }
  | { kind: 'is_gm' }
  | { kind: 'already_ended' }
  | { kind: 'kicked'; turnClosed: boolean };

/**
 * ISK-018: the server owner kicks a member in any phase but ended (one transaction, one audit row). Like the owner's
 * kick: sessions go, the name is blocked. In play the seat goes too, so a turn waiting only for them closes.
 */
export function kickFromGame(db: Db, gameId: string, memberId: string, now: number, rng: Rng): KickOutcome {
  return db.transaction((tx): KickOutcome => {
    if (!gameExists(tx, gameId)) return { kind: 'game_not_found' };
    if (hasEnded(tx, gameId)) return { kind: 'already_ended' };
    const target = tx.select({ kickedAt: member.kickedAt, role: member.role }).from(member).where(and(eq(member.id, memberId), eq(member.gameId, gameId))).get();
    if (!target) return { kind: 'member_not_found' };
    if (target.kickedAt !== null) return { kind: 'already_kicked' };
    // Q-397: without its Human GM a GM game would wait for approvals forever.
    if (target.role === 'gm') return { kind: 'is_gm' };
    blockMember(tx, memberId, now);
    tx.insert(adminGameAudit).values({ action: 'kick', gameId, memberId, at: now }).run();
    // A turn being resolved keeps the seat until it is published (the room drops it then).
    const state = phaseOf(tx, gameId)?.state;
    if (state?.status !== 'collecting') return { kind: 'kicked', turnClosed: false };
    const next = withoutKicked(tx, gameId, state, rng);
    if (next !== state) savePhaseState(tx, gameId, next, now);
    return { kind: 'kicked', turnClosed: next.status === 'resolving' };
  });
}

export type InviteCodeOutcome = { kind: 'game_not_found' } | { kind: 'already_ended' } | { kind: 'renewed'; inviteCode: string };

/** ISK-018: a new invite code (the old one stops at once; members in the game stay). The audit row never holds the code. */
export function renewInviteCodeOf(db: Db, gameId: string, now: number): InviteCodeOutcome {
  return db.transaction((tx): InviteCodeOutcome => {
    if (!gameExists(tx, gameId)) return { kind: 'game_not_found' };
    if (hasEnded(tx, gameId)) return { kind: 'already_ended' };
    const inviteCode = renewGameInviteCode(tx, gameId);
    tx.insert(adminGameAudit).values({ action: 'invite_code', gameId, memberId: null, at: now }).run();
    return { kind: 'renewed', inviteCode };
  });
}

export type CloseOutcome =
  | { kind: 'not_found' }
  | { kind: 'confirm_required' }
  | { kind: 'reason_too_long' }
  | { kind: 'already_ended' }
  | ({ kind: 'closed' } & Closure);

/**
 * Closes a game that has not ended, once (one transaction: a second close, at once or later, finds the row).
 * A game being played goes to `finale` with no AI ending (an ending still being written is marked told, so its late
 * result is dropped); a lobby / setup game only gets the row (no end page, not a learning source).
 */
export function closeGame(db: Db, gameId: string, input: { confirmName: string; reason?: string | undefined }, now: number): CloseOutcome {
  const reason = (input.reason ?? '').trim();
  return db.transaction((tx): CloseOutcome => {
    const row = tx.select({ name: game.name, startedAt: game.startedAt }).from(game).where(eq(game.id, gameId)).get();
    if (!row) return { kind: 'not_found' };
    if (input.confirmName.trim().normalize('NFC') !== row.name.normalize('NFC')) return { kind: 'confirm_required' };
    if ([...reason].length > CLOSE_REASON_MAX) return { kind: 'reason_too_long' };
    const phase = phaseOf(tx, gameId);
    if (closureOf(tx, gameId) !== null || endedOnItsOwn(tx, gameId, phase?.state)) return { kind: 'already_ended' };

    const hasSummary = row.startedAt !== null && phase !== null;
    tx.insert(gameClose).values({ gameId, gameName: row.name, reason: reason || null, hasSummary, closedAt: now }).run();
    if (phase) {
      if (!isEnded(phase.state)) savePhaseState(tx, gameId, { ...phase.state, status: 'finale' }, now);
      if (getEnding(tx, gameId)?.narrated === false) markNarrated(tx, gameId, now);
    }
    return { kind: 'closed', reason: reason || null, hasSummary };
  });
}
