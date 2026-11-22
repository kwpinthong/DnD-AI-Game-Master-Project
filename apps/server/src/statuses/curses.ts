import type { GmCurseView } from '@isekai/protocol';
import { PERIODS, TURNS_PER_PERIOD, restorePhaseState, type Period, type PhaseActionsLog, type StatusEffect, type Turn } from '@isekai/rules';
import { and, eq } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { AbilityRecord, ItemRecord } from '../assets/model.ts';
import type { DbOrTx } from '../db/client.ts';
import { gamePhase, gameStatus } from '../db/schema.ts';
import { itemsInGame, skillsInGame } from '../crossplayer/items.ts';

/**
 * Timed curses (GEN-095, Q-142 / Q-212): a skill or item row whose effect is a negative `dice_bonus` with a
 * Duration in periods (the sheet's Venom of Despair: d20 -3, {period, 2}) puts a status on the target of an
 * action that succeeds with it activated: a player target, else the action's NPC target.
 *
 * - Time: periods are 2 turns each (GEN-063), so 2 periods = 4 turns. The status works on the 4 turns after
 *   the cast turn (not the rest of the cast turn: the order of a turn is the priority roll) and is gone after.
 *   Stored as turn indexes over the game (`turnIndex`), so nothing ticks and a restart reads the same.
 * - Casting the same curse on a holder who still has it resets the 4 turns; the value stays (Q-212).
 * - The rules engine applies it as an `origin: 'curse'` status, mods `all` (every roll, defence included).
 * - The player sees only its label (`curseLabelsOf`); the Human GM the number and turns left (`gmCursesOf`).
 */

export interface CurseSpec {
  /** The Ability / Item name. */
  readonly source: string;
  readonly label: string;
  /** d20 change (negative). */
  readonly value: number;
  readonly turns: number;
}

/** 0 = day 1 EOSORIA turn 1; +1 per turn. */
export function turnIndex(at: { day: number; phase: Period; turn: Turn }): number {
  return ((at.day - 1) * PERIODS.length + PERIODS.indexOf(at.phase)) * TURNS_PER_PERIOD + (at.turn - 1);
}

/** The turn the game is on (the one being collected or resolved); null before the room has a state. */
export function currentTurnIndex(db: DbOrTx, gameId: string): number | null {
  const row = db.select({ state: gamePhase.state }).from(gamePhase).where(eq(gamePhase.gameId, gameId)).get();
  return row ? turnIndex(restorePhaseState(JSON.parse(row.state))) : null;
}

/** "สาปเป้าหมาย 1 คนให้ติดสถานะ หวาดกลัว (...)" → "หวาดกลัว". */
const LABEL = /ติดสถานะ\s*([^\s(]+)/;

/** The curse a row puts on its target, or null when it has none. */
export function curseOf(record: AbilityRecord | ItemRecord, name: string): CurseSpec | null {
  const effect = record.effects.find((e) => e.type === 'dice_bonus' && e.value < 0 && e.duration.unit === 'period');
  if (!effect || effect.duration.unit !== 'period') return null;
  const text = 'effect' in record ? record.effect : record.description;
  return { source: name, label: LABEL.exec(text)?.[1] ?? name, value: effect.value, turns: effect.duration.count * TURNS_PER_PERIOD };
}

/** The curse of an actor's owned skill / held item `ref` (a loot option id). */
function curseOfRef(db: DbOrTx, gameId: string, assets: GameAssets, actorId: string, ref: string): CurseSpec | null {
  const skill = (skillsInGame(db, gameId).get(actorId) ?? []).find((s) => s.id === ref);
  const skillRow = skill ? assets.ability(skill.name) : undefined;
  if (skill && skillRow) return curseOf(skillRow, skill.name);
  const item = itemsInGame(db, gameId).get(ref);
  const itemRow = item && item.holderMemberId === actorId ? assets.item(item.name) : undefined;
  return item && itemRow ? curseOf(itemRow, itemRow.nameEn) : null;
}

/** Writes the curses of the phase's successful actions (call inside the phase transaction, before the turn advances). */
export function recordCurses(db: DbOrTx, gameId: string, log: PhaseActionsLog, assets: GameAssets, now: number): void {
  const current = currentTurnIndex(db, gameId);
  if (current === null) return;
  for (const o of log.outcomes) {
    if (o.status !== 'resolved' || (o.log.degree !== 'success' && o.log.degree !== 'crit')) continue;
    const holder =
      o.target !== null
        ? { holderKind: 'player' as const, holderId: o.target.playerId }
        : o.log.input.proposal.target !== null
          ? { holderKind: 'npc' as const, holderId: o.log.input.proposal.target.npc }
          : null;
    if (holder === null) continue;
    for (const { ref } of o.log.tagging?.targetBonuses ?? []) {
      const curse = curseOfRef(db, gameId, assets, o.actorId, ref);
      if (curse === null) continue;
      const time = { label: curse.label, value: curse.value, fromTurn: current + 1, untilTurn: current + curse.turns, castBy: o.actorId, updatedAt: now };
      db.insert(gameStatus)
        .values({ gameId, ...holder, source: curse.source, ...time })
        .onConflictDoUpdate({ target: [gameStatus.gameId, gameStatus.holderKind, gameStatus.holderId, gameStatus.source], set: time })
        .run();
    }
  }
}

type StatusRow = typeof gameStatus.$inferSelect;

/** Rows working on the game's current turn. */
function activeRows(db: DbOrTx, gameId: string, holder?: { kind: 'player' | 'npc'; id: string }): { row: StatusRow; turnsLeft: number }[] {
  const current = currentTurnIndex(db, gameId);
  if (current === null) return [];
  const where = holder
    ? and(eq(gameStatus.gameId, gameId), eq(gameStatus.holderKind, holder.kind), eq(gameStatus.holderId, holder.id))
    : eq(gameStatus.gameId, gameId);
  return db
    .select()
    .from(gameStatus)
    .where(where)
    .all()
    .filter((r) => r.fromTurn <= current && current <= r.untilTurn)
    .map((row) => ({ row, turnsLeft: row.untilTurn - current + 1 }));
}

function toStatus({ row, turnsLeft }: { row: StatusRow; turnsLeft: number }): StatusEffect {
  return {
    id: `curse:${row.source}`,
    label: row.label,
    polarity: 'debuff',
    origin: 'curse',
    visible: true,
    mods: [{ scope: 'all', value: row.value }],
    phasesLeft: turnsLeft,
    ref: row.source,
  };
}

export interface ActiveCurses {
  readonly players: ReadonlyMap<string, StatusEffect[]>;
  readonly npcs: ReadonlyMap<string, StatusEffect[]>;
}

/** Every curse working on the current turn, by player member id and by NPC id. */
export function activeCurses(db: DbOrTx, gameId: string): ActiveCurses {
  const players = new Map<string, StatusEffect[]>();
  const npcs = new Map<string, StatusEffect[]>();
  for (const active of activeRows(db, gameId)) {
    const map = active.row.holderKind === 'player' ? players : npcs;
    map.set(active.row.holderId, [...(map.get(active.row.holderId) ?? []), toStatus(active)]);
  }
  return { players, npcs };
}

/** What the player sees of their own curses: the words only. */
export function curseLabelsOf(db: DbOrTx, gameId: string, memberId: string): string[] {
  return activeRows(db, gameId, { kind: 'player', id: memberId }).map(({ row }) => row.label);
}

/** What the Human GM sees of a player's curses. */
export function gmCursesOf(db: DbOrTx, gameId: string, memberId: string): GmCurseView[] {
  return activeRows(db, gameId, { kind: 'player', id: memberId }).map(({ row, turnsLeft }) => ({ label: row.label, source: row.source, value: row.value, turnsLeft }));
}
