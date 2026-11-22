import type { HitChange, TurnChange } from '@isekai/protocol';
import { isDrowsy, karmaTitle, type PhaseLogEntry, type PhaseState } from '@isekai/rules';
import { eq, inArray } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import { heldItemsOf } from '../crossplayer/items.ts';
import type { DbOrTx } from '../db/client.ts';
import { character } from '../db/schema.ts';
import { INN_REST_COINS } from '../game/location-actions.ts';
import { curseLabelsOf } from '../statuses/curses.ts';

/**
 * GEN-114: the changes of a player's own values, worked out by the server from the character before and after
 * (never from the AI's narration). A snapshot holds exactly what the status bar shows; karma only as its word.
 */
export interface StatSnapshot {
  readonly hp: number;
  readonly stamina: number;
  readonly coins: number;
  readonly conduct: string;
  readonly items: readonly string[];
  readonly statuses: readonly string[];
}

const DROWSY_LABEL = 'ง่วงซึม';

export function snapshotsOf(db: DbOrTx, assets: GameAssets, gameId: string, state: PhaseState, memberIds: readonly string[]): Map<string, StatSnapshot> {
  const rows = memberIds.length === 0 ? [] : db.select().from(character).where(inArray(character.memberId, [...memberIds])).all();
  const out = new Map<string, StatSnapshot>();
  for (const row of rows) {
    const player = state.players[row.memberId];
    const statuses = curseLabelsOf(db, gameId, row.memberId);
    if (player && isDrowsy(player, state.day) && !statuses.includes(DROWSY_LABEL)) statuses.push(DROWSY_LABEL);
    out.set(row.memberId, {
      hp: row.hp,
      stamina: row.stamina,
      coins: row.coins,
      conduct: karmaTitle(row.karma, assets.karmaTiers),
      items: heldItemsOf(db, gameId, row.memberId).map((i) => i.name),
      statuses,
    });
  }
  return out;
}

/** The character's name, for the Human GM's view of whose log it is. */
export function nameOf(db: DbOrTx, memberId: string): string {
  return db.select({ name: character.name }).from(character).where(eq(character.memberId, memberId)).get()?.name ?? '';
}

const ACTION = 'การกระทำในเทิร์นนี้';
const HIT = 'ถูกคนอื่นลงมือ';

/** What the turn's engine log, hazards and the hits on this player say about why. */
export interface TurnReasons {
  readonly log: readonly PhaseLogEntry[];
  /** Stamina lost to a hazard place this turn, by member. */
  readonly hazard: ReadonlyMap<string, number>;
  readonly hits: ReadonlyMap<string, readonly HitChange[]>;
}

/** Whole-number parts that explain `total`; what no part explains stays as `rest` (reason `fallback`). Zero parts are dropped. */
function split(total: number, parts: readonly (readonly [number, string])[], fallback: string): { delta: number; reason: string }[] {
  const out: { delta: number; reason: string }[] = [];
  let left = total;
  for (const [delta, reason] of parts) {
    // Never explain more than what really changed, nor in the other direction.
    const take = delta > 0 ? Math.min(delta, Math.max(left, 0)) : Math.max(delta, Math.min(left, 0));
    if (take !== 0) {
      out.push({ delta: take, reason });
      left -= take;
    }
  }
  if (left !== 0) out.push({ delta: left, reason: fallback });
  return out;
}

/**
 * The changes of one member over one turn. `s0` = before the turn's effects, `s1` = after the resolver's own writes,
 * `s2` = at the turn's end. Stats are in the status bar's own units; no zero is listed (C3).
 */
export function turnChangesOf(memberId: string, s0: StatSnapshot, s1: StatSnapshot, s2: StatSnapshot, why: TurnReasons): TurnChange[] {
  const mine = why.log.filter((e): e is Extract<PhaseLogEntry, { playerId: string }> => 'playerId' in e && e.playerId === memberId);
  const hits = why.hits.get(memberId) ?? [];
  const hitDelta = (stat: 'hp' | 'stamina' | 'coins') => hits.reduce((sum, h) => sum + (h.stat === stat ? h.delta : 0), 0);
  const recovered = mine.flatMap((e) => (e.type === 'recovered' ? [e] : []));
  const rested = (stat: 'hp' | 'stamina') => recovered.reduce((sum, e) => sum + e[stat].gain, 0);
  const drowsyCost = mine.reduce((sum, e) => sum + (e.type === 'drowsy_cost' ? e.stamina.before - e.stamina.after : 0), 0);
  const out: TurnChange[] = [];

  for (const c of split(s2.hp - s0.hp, [[rested('hp'), 'พักผ่อน'], [hitDelta('hp'), 'ถูกโจมตี']], ACTION)) out.push({ stat: 'hp', ...c });
  const hazard = why.hazard.get(memberId) ?? 0;
  for (const c of split(s2.stamina - s0.stamina, [[rested('stamina'), 'พักผ่อน'], [-drowsyCost, DROWSY_LABEL], [-hazard, 'พื้นที่อันตราย'], [hitDelta('stamina'), 'ถูกโจมตี']], ACTION)) {
    out.push({ stat: 'stamina', ...c });
  }
  // Coins: what the resolver wrote (s0 -> s1), then the inn / clinic at the turn's close (s1 -> s2).
  const inn = recovered.some((e) => e.site === 'inn');
  const clinic = mine.some((e) => e.type === 'carried_to_clinic');
  for (const c of split(s1.coins - s0.coins, [[hitDelta('coins'), HIT]], ACTION)) out.push({ stat: 'coins', ...c });
  for (const c of split(s2.coins - s1.coins, [[inn ? -INN_REST_COINS : 0, 'ค่าที่พักโรงเตี๊ยม'], [clinic ? -Infinity : 0, 'ค่ารักษาที่คลินิก']], ACTION)) {
    out.push({ stat: 'coins', ...c });
  }
  if (s0.conduct !== s2.conduct) out.push({ stat: 'conduct', from: s0.conduct, to: s2.conduct, reason: ACTION });

  const lostByHit = new Set(hits.flatMap((h) => (h.stat === 'item_lost' ? [h.name] : [])));
  for (const name of s0.items) if (!s2.items.includes(name)) out.push({ stat: 'item_lost', name, reason: lostByHit.has(name) ? 'ถูกแย่งไป' : ACTION });
  for (const name of s2.items) if (!s0.items.includes(name)) out.push({ stat: 'item_gained', name, reason: ACTION });
  const hitStatus = new Set(hits.flatMap((h) => (h.stat === 'status' ? [h.name] : [])));
  for (const name of s2.statuses) {
    if (s0.statuses.includes(name)) continue;
    out.push({ stat: 'status_gained', name, reason: hitStatus.has(name) ? HIT : name === DROWSY_LABEL ? 'อดนอน' : ACTION });
  }
  for (const name of s0.statuses) if (!s2.statuses.includes(name)) out.push({ stat: 'status_lost', name, reason: name === DROWSY_LABEL ? 'พักชดเชยแล้ว' : 'หมดเวลา' });
  return out;
}

/** A trip's Stamina (and anything else it cost) between two snapshots of one move. */
export function moveChangesOf(before: StatSnapshot, after: StatSnapshot, kind: 'same_zone' | 'cross_zone' | 'rift'): TurnChange[] {
  const reason = kind === 'cross_zone' ? 'เดินทางข้ามโซน' : kind === 'rift' ? 'เข้ามิติพิศวง' : 'เดินทางในโซนเดียวกัน';
  const out: TurnChange[] = [];
  if (after.stamina !== before.stamina) out.push({ stat: 'stamina', delta: after.stamina - before.stamina, reason });
  if (after.coins !== before.coins) out.push({ stat: 'coins', delta: after.coins - before.coins, reason });
  return out;
}
