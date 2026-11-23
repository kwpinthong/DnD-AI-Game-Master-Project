import { restorePhaseState, seatPlayer, TURNS_PER_PERIOD, turnNumber, type PhaseState, type Rng, type TurnPoint } from '@isekai/rules';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.ts';
import { character, game, gamePhase, lateJoin, member } from '../db/schema.ts';
import type { GameAssets } from '../assets/load.ts';
import { maskNames } from '../gm/check.ts';
import { getGameScenario } from '../scenario/store.ts';
import { placeCharacter } from '../visibility/store.ts';
import { titleOf } from './character.ts';
import { membersWithLootChoice } from './loot.ts';
import { originOf, rollOriginFor } from './origin.ts';
import type { MemberRow } from './service.ts';

/**
 * ISK-015: joining an Online game after it started. A newcomer (a `late_join` row) makes their character and
 * picks loot while the turns go on without them, then spawns (`spawnLateJoiner`: the start scenario of the same
 * table, Karma 0, nothing to make up for the days missed) and takes a seat when the next turn opens
 * (`seatArrivals`). Not spawned once a whole period went by after the one they joined in = dropped.
 */

/** The last game day a newcomer may join on (checked at join time only). */
export const LAST_JOIN_DAY = 9;

export type LateJoinCheck = { kind: 'single_mode' } | { kind: 'game_ended' } | { kind: 'join_closed_day' } | { kind: 'ok'; turn: number };

/** The stored engine state without making one (none yet = day 1, turn 1). */
function storedState(db: DbOrTx, gameId: string): PhaseState | null {
  const row = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get();
  return row ? restorePhaseState(JSON.parse(row.state)) : null;
}

const ended = (s: PhaseState | null) => s !== null && (s.status === 'finale' || s.status === 'game_over');

/** Whether a newcomer may join this started game now, and the turn they join at. */
export function lateJoinCheck(db: DbOrTx, row: { id: string; mode: 'online' | 'single' }): LateJoinCheck {
  if (row.mode === 'single') return { kind: 'single_mode' };
  const state = storedState(db, row.id);
  // shortcut: only the engine's own end counts; ISK-001's closed game is refused here too once it is merged.
  if (ended(state)) return { kind: 'game_ended' };
  if ((state?.day ?? 1) > LAST_JOIN_DAY) return { kind: 'join_closed_day' };
  return { kind: 'ok', turn: state ? turnNumber(state) : 1 };
}

const lateJoinOf = (db: DbOrTx, memberId: string) => db.select().from(lateJoin).where(eq(lateJoin.memberId, memberId)).get();

/** Joined after the start and not spawned yet: they may still make their character and choose loot. */
export function isPreparing(db: DbOrTx, memberId: string): boolean {
  return lateJoinOf(db, memberId)?.spawnedTurn === null;
}

/** The character and loot are fixed: the game started, unless `me` joined late and has not spawned yet. */
export function setupLocked(db: DbOrTx, me: Pick<MemberRow, 'id' | 'gameId'>): boolean {
  const started = (db.select({ startedAt: game.startedAt }).from(game).where(eq(game.id, me.gameId)).get()?.startedAt ?? null) !== null;
  return started && !isPreparing(db, me.id);
}

/** Spawned after joining late; true until they take their seat at the next turn (the caller checks the seat). */
export function hasSpawnedLate(db: DbOrTx, memberId: string): boolean {
  return (lateJoinOf(db, memberId)?.spawnedTurn ?? null) !== null;
}

export type SpawnOutcome =
  | { kind: 'ok' }
  | { kind: 'gm_has_no_character' }
  | { kind: 'not_preparing' }
  | { kind: 'character_not_found' }
  | { kind: 'no_loot' }
  | { kind: 'game_ended' };

/** The newcomer's start scenario (rolled like everyone's; no roll without an Rng) with Karma 0. */
export function spawnLateJoiner(db: Db, me: MemberRow, assets: GameAssets, rng: Rng | null, now: () => number): SpawnOutcome {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  return db.transaction((tx): SpawnOutcome => {
    if (!isPreparing(tx, me.id)) return { kind: 'not_preparing' };
    if (!tx.select({ id: character.memberId }).from(character).where(eq(character.memberId, me.id)).get()) return { kind: 'character_not_found' };
    if (!membersWithLootChoice(tx, [me.id]).has(me.id)) return { kind: 'no_loot' };
    const state = storedState(tx, me.gameId);
    // shortcut: ISK-001's game_closed is not merged yet; a game that ended while they prepared answers game_ended.
    if (ended(state)) return { kind: 'game_ended' };
    const t = now();
    if (rng !== null) rollOriginFor(tx, me.gameId, me.id, assets, rng, t);
    tx.update(character).set({ karma: 0, updatedAt: t }).where(eq(character.memberId, me.id)).run();
    tx.update(lateJoin).set({ spawnedTurn: state ? turnNumber(state) : 1 }).where(eq(lateJoin.memberId, me.id)).run();
    return { kind: 'ok' };
  });
}

/**
 * At a turn that opens: every spawned newcomer not seated yet takes the last seat and stands at their spawn
 * point (the scenario's first place without one). Returns the state with them and who arrived.
 */
export function seatArrivals(tx: DbOrTx, gameId: string, state: PhaseState, now: number): { state: PhaseState; arrived: string[] } {
  const waiting = tx
    .select({ memberId: lateJoin.memberId })
    .from(lateJoin)
    .where(and(eq(lateJoin.gameId, gameId), isNotNull(lateJoin.spawnedTurn)))
    .all()
    .filter((r) => !state.players[r.memberId]);
  if (waiting.length === 0) return { state, arrived: [] };
  const first = getGameScenario(tx, gameId)?.locations[0]?.id;
  let next = state;
  const arrived: string[] = [];
  for (const { memberId } of waiting) {
    const c = tx.select().from(character).where(eq(character.memberId, memberId)).get();
    const place = originOf(tx, memberId)?.locationId ?? first;
    if (!c || place === undefined) continue;
    next = seatPlayer(next, { id: memberId, hp: c.hp, hpMax: c.hpMax, stamina: c.stamina, karma: c.karma });
    placeCharacter(tx, gameId, memberId, place, now);
    arrived.push(memberId);
  }
  return { state: next, arrived };
}

const periodOf = (turn: number) => Math.ceil(turn / TURNS_PER_PERIOD);

/** A period opened at `opened`: newcomers still not spawned a whole period after the one they joined in leave the game. */
export function dropLateJoiners(tx: DbOrTx, gameId: string, opened: TurnPoint): void {
  const now = periodOf(turnNumber(opened));
  const stale = tx
    .select({ memberId: lateJoin.memberId, joinedTurn: lateJoin.joinedTurn })
    .from(lateJoin)
    .where(and(eq(lateJoin.gameId, gameId), isNull(lateJoin.spawnedTurn)))
    .all()
    .filter((r) => now - periodOf(r.joinedTurn) >= 2)
    .map((r) => r.memberId);
  // The member row goes (its sessions, character and loot with it): the seat is free and the name may join again.
  if (stale.length > 0) tx.delete(member).where(inArray(member.id, stale)).run();
}

/** What the players who do not know the newcomer read: their title and look, never their name. */
export function arrivalText(tx: DbOrTx, memberId: string): string {
  const c = tx.select().from(character).where(eq(character.memberId, memberId)).get();
  const m = tx.select({ name: member.name }).from(member).where(eq(member.id, memberId)).get();
  if (!c) return 'มีผู้มาใหม่ปรากฏตัวในเมือง';
  const title = titleOf(c);
  const look = maskNames(c.appearance, new Map([c.name, m?.name ?? ''].filter((n) => n.trim().length > 0).map((n) => [n, title] as const)));
  return `มีผู้มาใหม่ปรากฏตัวในเมือง: ${title} ${look}`;
}
