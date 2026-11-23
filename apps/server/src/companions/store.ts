import { bondFor, type CompanionView, type NpcView, type Scenario, type ScenarioNpc } from '@isekai/protocol';
import {
  applyAffinityDelta,
  checkNpcSpawn,
  COMPANION_LIMIT,
  evolutionPath,
  GAME_DAYS,
  rankCompanions,
  type EvolutionCondition,
  type NpcAlignment,
  type NpcGrade,
  type NpcProgress,
  type NpcRuleError,
  type Period,
} from '@isekai/rules';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, karmaDay, member, npcActivity, npcBond, npcFlag, npcRef, npcReward } from '../db/schema.ts';
import type { MemberRow } from '../game/service.ts';
import { npcsHereNow } from '../gm/npc-lines.ts';
import { getGameScenario, updateGameScenario } from '../scenario/store.ts';
import { presenceOf } from '../visibility/store.ts';
import { sheetNpcFor, type NpcRewardRef, type RewardSegment, type SheetNpc } from './sheet.ts';

/**
 * NPC companions, names, evolution and rewards (GEN-054). The NPC tab of the Asset sheet wins over the GDD:
 * a scenario NPC whose name is a sheet NPC takes its grade, names, Evolution / Unlock Condition
 * (`evolution-rules.ts`) and Rewards & Abilities from there (`sheet.ts`). A scenario-only NPC keeps its own
 * rank and names and has no evolution or rewards.
 *
 * Everything is per player: one player's affinity, flags and evolution do not change the NPC for another.
 * The AI GM loop (GEN-057) calls these functions; players only save / release companions (routes.ts) and
 * never get affinity, grades, flags or karma.
 */

export interface GameTime {
  /** Game day 1..12. */
  readonly day: number;
  readonly now: number;
}

export interface Evolution {
  readonly npcId: string;
  readonly grade: 'S' | 'SS';
  readonly alignment: NpcAlignment | null;
}

export type CompanionErrorCode =
  | 'unknown_npc'
  | 'unknown_flag'
  | 'wrong_day'
  | 'bad_day'
  | 'not_in_rewards'
  | 'not_unlocked'
  | 'already_given'
  | 'invalid_npc';
export interface CompanionError {
  readonly code: CompanionErrorCode | NpcRuleError['code'];
  readonly message: string;
}
type Fail = { ok: false; error: CompanionError };
const fail = (code: CompanionError['code'], message: string): Fail => ({ ok: false, error: { code, message } });

type BondRow = typeof npcBond.$inferSelect;

/** A scenario NPC seen from one player. */
interface NpcContext {
  readonly gameId: string;
  readonly memberId: string;
  readonly npc: Scenario['npcs'][number];
  readonly sheet: SheetNpc | undefined;
  readonly baseGrade: NpcGrade;
}

function gameOf(db: DbOrTx, memberId: string): string | undefined {
  return db.select({ gameId: member.gameId }).from(member).where(eq(member.id, memberId)).get()?.gameId;
}

function contextFor(db: DbOrTx, assets: GameAssets, memberId: string, npcId: string): NpcContext | undefined {
  const gameId = gameOf(db, memberId);
  const npc = gameId ? getGameScenario(db, gameId)?.npcs.find((n) => n.id === npcId) : undefined;
  if (!gameId || !npc) return undefined;
  const sheet = sheetNpcFor(assets, npc);
  return { gameId, memberId, npc, sheet, baseGrade: sheet?.grade ?? npc.rank };
}

const unknownNpc = () => fail('unknown_npc', 'no NPC with that id in this game');
const badDay = (day: number) =>
  Number.isInteger(day) && day >= 1 && day <= GAME_DAYS ? null : fail('bad_day', `day must be 1..${GAME_DAYS}`);

function bondOf(db: DbOrTx, memberId: string, npcId: string): BondRow | undefined {
  return db
    .select()
    .from(npcBond)
    .where(and(eq(npcBond.memberId, memberId), eq(npcBond.npcId, npcId)))
    .get();
}

function upsertBond(db: DbOrTx, memberId: string, npcId: string, set: Partial<Omit<BondRow, 'memberId' | 'npcId'>>, now: number): void {
  db.insert(npcBond)
    .values({ memberId, npcId, ...set, updatedAt: now })
    .onConflictDoUpdate({ target: [npcBond.memberId, npcBond.npcId], set: { ...set, updatedAt: now } })
    .run();
}

/** The name `ctx`'s player sees, and whether it is the real one (Q-103 / Q-219: grades B and S hide it). */
function displayName(ctx: NpcContext, bond: BondRow | undefined): { name: string; nameRevealed: boolean } {
  if (bond?.evolvedGrade) return { name: ctx.sheet ? ctx.sheet.evolvedName(bond.evolvedAlignment) : ctx.npc.name, nameRevealed: true };
  // GEN-121: every grade shows its alias until this player knows it (F / A name heard, B +9, S met / awakened); a companion
  // saved before this rule counts as known.
  const shown = (bond?.nameRevealed ?? false) || bond?.companionSeq != null;
  if (!ctx.sheet) return { name: shown ? ctx.npc.name : ctx.npc.alias, nameRevealed: shown };
  return { name: shown ? ctx.sheet.realName : ctx.sheet.hiddenName, nameRevealed: shown };
}

/** Grade B: the affinity in the sheet's condition ("ความสัมพันธ์ถึง +9"); a scenario-only B uses +9 too. */
const revealAt = (ctx: NpcContext) => (ctx.baseGrade === 'B' ? (ctx.sheet?.revealAffinity ?? 9) : null);

// --- Karma seen per day ("กรรม -1..+1 ตลอด") ---

/** Records the player's karma now as seen on `day` (the lowest / highest of that day). Every function below calls it. */
export function observeKarma(db: DbOrTx, memberId: string, day: number): void {
  const karma = db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma;
  if (karma === undefined) return;
  db.insert(karmaDay)
    .values({ memberId, day, min: karma, max: karma })
    .onConflictDoUpdate({
      target: [karmaDay.memberId, karmaDay.day],
      set: { min: sql`min(${karmaDay.min}, ${karma})`, max: sql`max(${karmaDay.max}, ${karma})` },
    })
    .run();
}

function progressOf(db: DbOrTx, memberId: string, npcId: string, day: number): NpcProgress {
  const karma = db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma ?? 0;
  const flags = db
    .select({ flag: npcFlag.flag, count: npcFlag.count })
    .from(npcFlag)
    .where(and(eq(npcFlag.memberId, memberId), eq(npcFlag.npcId, npcId)))
    .all();
  const activities = db
    .select({ day: npcActivity.day, period: npcActivity.period })
    .from(npcActivity)
    .where(and(eq(npcActivity.memberId, memberId), eq(npcActivity.npcId, npcId)))
    .all();
  const days = db.select().from(karmaDay).where(eq(karmaDay.memberId, memberId)).all();
  return {
    affinity: bondOf(db, memberId, npcId)?.affinity ?? 0,
    karma,
    day,
    flags: Object.fromEntries(flags.map((f) => [f.flag, { count: f.count }])),
    activities,
    karmaDays: Object.fromEntries(days.map((d) => [d.day, { min: d.min, max: d.max }])),
  };
}

// --- Rewards ---

/** Gives the rewards not given yet; returns the new ones. */
function give(db: DbOrTx, memberId: string, npcId: string, rewards: readonly NpcRewardRef[], now: number): NpcRewardRef[] {
  return rewards.filter(
    (r) =>
      db.insert(npcReward).values({ memberId, npcId, reward: r.name, kind: r.kind, grantedAt: now }).onConflictDoNothing().run().changes > 0,
  );
}

const segmentsAt = (ctx: NpcContext, stage: RewardSegment['stage'], alignment: NpcAlignment | null = null) =>
  (ctx.sheet?.rewards ?? []).filter((s) => s.stage === stage && (s.alignment === null || s.alignment === alignment));

/** Whether `segment` is open for this player now. */
function segmentOpen(segment: RewardSegment, bond: BondRow | undefined): boolean {
  switch (segment.stage) {
    case 'reveal':
      return bond?.nameRevealed ?? false;
    case 'quest':
    case 'base':
      return true;
    case 'evolved':
      return Boolean(bond?.evolvedGrade) && (segment.alignment === null || segment.alignment === bond?.evolvedAlignment);
  }
}

/**
 * The AI GM gives a reward of the NPC's Rewards & Abilities cell (a quest one such as Prism of Truth, or a grade A
 * NPC's own items). Refused, with nothing stored, when the reward is not in that NPC's cell, its segment is not
 * open yet (the +9 rewards before the reveal, the evolved ones before evolving / on the other path), or it was given.
 */
export function grantNpcReward(
  db: DbOrTx,
  assets: GameAssets,
  memberId: string,
  npcId: string,
  reward: string,
  now: number,
): { ok: true; kind: 'skill' | 'item' } | Fail {
  const ctx = contextFor(db, assets, memberId, npcId);
  if (!ctx) return unknownNpc();
  const segments = (ctx.sheet?.rewards ?? []).filter((s) => s.rewards.some((r) => r.name === reward));
  const ref = segments[0]?.rewards.find((r) => r.name === reward);
  if (!ref) return fail('not_in_rewards', `this NPC has no reward "${reward}" in its Rewards & Abilities`);
  const bond = bondOf(db, memberId, npcId);
  if (!segments.some((s) => segmentOpen(s, bond))) return fail('not_unlocked', `the reward "${reward}" is not open yet for this player`);
  if (give(db, memberId, npcId, [ref], now).length === 0) return fail('already_given', `the reward "${reward}" was already given`);
  return { ok: true, kind: ref.kind };
}

// --- Evolution ---

/** Evolves the NPC for this player when its rule holds now (once) and gives the evolved rewards. */
function tryEvolve(db: DbOrTx, ctx: NpcContext, at: GameTime): Evolution | null {
  const rule = ctx.sheet?.rule;
  if (!rule || bondOf(db, ctx.memberId, ctx.npc.id)?.evolvedGrade) return null;
  const path = evolutionPath(rule, progressOf(db, ctx.memberId, ctx.npc.id, at.day));
  if (!path) return null;
  // Q-219: awakening a grade S NPC reveals its real name to this player (narration tokens read `nameRevealed`).
  upsertBond(db, ctx.memberId, ctx.npc.id, { evolvedGrade: rule.to, evolvedAlignment: path.alignment, nameRevealed: true }, at.now);
  give(db, ctx.memberId, ctx.npc.id, segmentsAt(ctx, 'evolved', path.alignment).flatMap((s) => s.rewards), at.now);
  return { npcId: ctx.npc.id, grade: rule.to, alignment: path.alignment };
}

/** Checks every NPC of the player's game (call after karma changes). Returns the ones that evolved now. */
export function checkNpcEvolution(db: DbOrTx, assets: GameAssets, memberId: string, at: GameTime): Evolution[] {
  if (badDay(at.day)) return [];
  const gameId = gameOf(db, memberId);
  if (!gameId) return [];
  return db.transaction((tx) => {
    observeKarma(tx, memberId, at.day);
    return (getGameScenario(tx, gameId)?.npcs ?? []).flatMap((n) => {
      const ctx = contextFor(tx, assets, memberId, n.id);
      const evolved = ctx ? tryEvolve(tx, ctx, at) : null;
      return evolved ? [evolved] : [];
    });
  });
}

export type AffinityResult =
  | { ok: true; before: number; delta: number; after: number; nameRevealed: boolean; granted: NpcRewardRef[]; evolved: Evolution | null }
  | Fail;

/**
 * One action's affinity change with one NPC (±10 at most, Rules Spec §7; a bigger one is refused and nothing
 * changes). Reaching a grade B NPC's reveal affinity shows its real name and gives its "+9" rewards, once; the
 * name stays even if affinity drops later. Then checks evolution.
 */
export function changeNpcAffinity(db: DbOrTx, assets: GameAssets, memberId: string, npcId: string, delta: number, at: GameTime): AffinityResult {
  const ctx = contextFor(db, assets, memberId, npcId);
  if (!ctx) return unknownNpc();
  const wrongDay = badDay(at.day);
  if (wrongDay) return wrongDay;
  const before = bondOf(db, memberId, npcId);
  const change = applyAffinityDelta(before?.affinity ?? 0, delta);
  if (!change.ok) return { ok: false, error: change.error };
  return db.transaction((tx) => {
    observeKarma(tx, memberId, at.day);
    const threshold = revealAt(ctx);
    // GEN-121: grade B learns the name at its affinity; grade S only when met / awakened; F / A by name or introduction (GEN-170, `meetNpc`).
    const revealsNow = !(before?.nameRevealed ?? false) && threshold !== null && change.after >= threshold;
    upsertBond(tx, memberId, npcId, { affinity: change.after, ...(revealsNow ? { nameRevealed: true } : {}) }, at.now);
    const granted = revealsNow ? give(tx, memberId, npcId, segmentsAt(ctx, 'reveal').flatMap((s) => s.rewards), at.now) : [];
    const evolved = tryEvolve(tx, ctx, at);
    return { ...change, nameRevealed: displayName(ctx, bondOf(tx, memberId, npcId)).nameRevealed, granted, evolved };
  });
}

/**
 * GEN-170 (Q-320 B): this player heard a grade F / A NPC's real name (they said it, or it introduced itself), so they
 * know it from now on, with its reveal rewards. Grades B and S keep their own rules. Idempotent.
 */
export function meetNpc(db: DbOrTx, assets: GameAssets, memberId: string, npcId: string, now: number): void {
  const ctx = contextFor(db, assets, memberId, npcId);
  if (!ctx || ctx.baseGrade === 'B' || ctx.baseGrade === 'S' || bondOf(db, memberId, npcId)?.nameRevealed) return;
  upsertBond(db, memberId, npcId, { nameRevealed: true }, now);
  give(db, memberId, npcId, segmentsAt(ctx, 'reveal').flatMap((s) => s.rewards), now);
}

const flagConditions = (ctx: NpcContext) =>
  (ctx.sheet?.rule?.paths ?? []).flatMap((p) => p.all).filter((c): c is Extract<EvolutionCondition, { type: 'flag' }> => c.type === 'flag');

/**
 * The AI GM sets one of the NPC's condition flags for this player (the names are in `evolution-rules.ts`).
 * The server checks the numeric part: a flag tied to a day ("วันที่ 7") is refused on another day. Each call
 * adds one to the flag's count. Then checks evolution.
 */
export function setNpcFlag(
  db: DbOrTx,
  assets: GameAssets,
  memberId: string,
  npcId: string,
  flag: string,
  at: GameTime,
): { ok: true; count: number; evolved: Evolution | null } | Fail {
  const ctx = contextFor(db, assets, memberId, npcId);
  if (!ctx) return unknownNpc();
  const wrongDay = badDay(at.day);
  if (wrongDay) return wrongDay;
  const conditions = flagConditions(ctx).filter((c) => c.flag === flag);
  if (conditions.length === 0) return fail('unknown_flag', `"${flag}" is not a condition flag of this NPC`);
  if (!conditions.some((c) => (c.day === undefined || c.day === at.day) && (c.minDay === undefined || at.day >= c.minDay))) {
    return fail('wrong_day', `"${flag}" only counts on the day its condition names`);
  }
  return db.transaction((tx) => {
    observeKarma(tx, memberId, at.day);
    upsertBond(tx, memberId, npcId, {}, at.now);
    const row = tx
      .insert(npcFlag)
      .values({ memberId, npcId, flag, count: 1, day: at.day, updatedAt: at.now })
      .onConflictDoUpdate({
        target: [npcFlag.memberId, npcFlag.npcId, npcFlag.flag],
        set: { count: sql`${npcFlag.count} + 1`, day: at.day, updatedAt: at.now },
      })
      .returning({ count: npcFlag.count })
      .get();
    return { ok: true as const, count: row.count, evolved: tryEvolve(tx, ctx, at) };
  });
}

/** The player spent a turn of `period` on `at.day` doing something with the NPC (ลูเซีย's condition). Then checks evolution. */
export function recordNpcActivity(
  db: DbOrTx,
  assets: GameAssets,
  memberId: string,
  npcId: string,
  period: Period,
  at: GameTime,
): { ok: true; evolved: Evolution | null } | Fail {
  const ctx = contextFor(db, assets, memberId, npcId);
  if (!ctx) return unknownNpc();
  const wrongDay = badDay(at.day);
  if (wrongDay) return wrongDay;
  return db.transaction((tx) => {
    observeKarma(tx, memberId, at.day);
    upsertBond(tx, memberId, npcId, {}, at.now);
    tx.insert(npcActivity).values({ memberId, npcId, day: at.day, period, createdAt: at.now }).onConflictDoNothing().run();
    return { ok: true as const, evolved: tryEvolve(tx, ctx, at) };
  });
}

// --- Spawning ---

export type SpawnNpcInput = Omit<z.input<typeof ScenarioNpc>, 'rank'> & { readonly rank: string };

/** The AI GM brings a new NPC into the game's scenario. Grade SS never spawns (only F evolves to it); nothing changes then. */
export function spawnNpc(db: DbOrTx, gameId: string, npc: SpawnNpcInput, now: number): { ok: true } | Fail {
  const spawnError = checkNpcSpawn(npc.rank);
  if (spawnError) return { ok: false, error: spawnError };
  const scenario = getGameScenario(db, gameId);
  if (!scenario) return fail('invalid_npc', 'the game has no scenario');
  const result = updateGameScenario(db, gameId, { ...scenario, npcs: [...scenario.npcs, npc] }, now);
  if (!result.ok) {
    return fail('invalid_npc', result.code === 'invalid' ? result.errors.map((e) => `${e.path}: ${e.message}`).join('; ') : 'the game has no scenario');
  }
  return { ok: true };
}

// --- Refs and what the player sees ---

/** The opaque per-game ref of each NPC id (made on first use). */
export function npcRefs(db: DbOrTx, gameId: string, npcIds: readonly string[]): Map<string, string> {
  for (const npcId of npcIds) {
    db.insert(npcRef).values({ gameId, npcId, ref: randomBytes(12).toString('base64url') }).onConflictDoNothing().run();
  }
  const rows = db.select().from(npcRef).where(eq(npcRef.gameId, gameId)).all();
  return new Map(rows.filter((r) => npcIds.includes(r.npcId)).map((r) => [r.npcId, r.ref]));
}

export function npcIdForRef(db: DbOrTx, gameId: string, ref: string): string | undefined {
  return db
    .select({ npcId: npcRef.npcId })
    .from(npcRef)
    .where(and(eq(npcRef.gameId, gameId), eq(npcRef.ref, ref)))
    .get()?.npcId;
}

const karmaNow = (db: DbOrTx, memberId: string) => db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma ?? 0;

/** The NPCs at `locationId` now as `memberId` sees them (GET /api/game/surroundings); GEN-175: the turn's "here" rule. */
export function npcViewsAt(db: DbOrTx, assets: GameAssets, memberId: string, gameId: string, locationId: string): NpcView[] {
  const here = npcsHereNow(db, assets, gameId, locationId, karmaNow(db, memberId));
  const refs = npcRefs(db, gameId, here.map((n) => n.id));
  return here.map((n) => {
    const ctx = contextFor(db, assets, memberId, n.id)!;
    return { ref: refs.get(n.id)!, ...displayName(ctx, bondOf(db, memberId, n.id)) };
  });
}

/** GEN-182: each NPC this player has a bond with: the name they may see and the bond word (never the number). */
export function bondWordsOf(db: DbOrTx, assets: GameAssets, memberId: string): Record<string, { name: string; word: string }> {
  const out: Record<string, { name: string; word: string }> = {};
  for (const b of db.select().from(npcBond).where(eq(npcBond.memberId, memberId)).all()) {
    const ctx = contextFor(db, assets, memberId, b.npcId);
    if (ctx) out[b.npcId] = { name: displayName(ctx, b).name, word: bondFor(b.affinity).word };
  }
  return out;
}

/**
 * An NPC as `memberId` reads it in a line it says (GEN-110): the opaque ref, the name this player may see (alias until the
 * real name is known, Q-219) and the grade only once that name is shown (a hidden name keeps its grade hidden too).
 */
export function npcSpeaker(db: DbOrTx, assets: GameAssets, memberId: string, npcId: string): { ref: string; name: string; grade?: NpcGrade } | undefined {
  const ctx = contextFor(db, assets, memberId, npcId);
  if (!ctx) return undefined;
  const bond = bondOf(db, memberId, npcId);
  const shown = displayName(ctx, bond);
  return {
    ref: npcRefs(db, ctx.gameId, [npcId]).get(npcId)!,
    name: shown.name,
    ...(shown.nameRevealed ? { grade: bond?.evolvedGrade ?? ctx.baseGrade } : {}),
  };
}

export interface NpcState {
  readonly npcId: string;
  readonly ref: string;
  readonly name: string;
  readonly nameRevealed: boolean;
  /** The grade it started with (the sheet's, or the scenario rank for a scenario-only NPC). */
  readonly baseGrade: NpcGrade;
  /** The grade now for this player. */
  readonly grade: NpcGrade;
  readonly evolved: boolean;
  readonly alignment: NpcAlignment | null;
  readonly affinity: number;
  readonly companion: boolean;
  /** Flag → count. */
  readonly flags: Readonly<Record<string, number>>;
  /** Rewards given, by name. */
  readonly rewards: readonly string[];
}

/** Everything about one NPC for one player: for the AI GM loop and the Human GM, never for players. */
export function npcStateFor(db: DbOrTx, assets: GameAssets, memberId: string, npcId: string): NpcState | undefined {
  const ctx = contextFor(db, assets, memberId, npcId);
  if (!ctx) return undefined;
  const bond = bondOf(db, memberId, npcId);
  const flags = db
    .select({ flag: npcFlag.flag, count: npcFlag.count })
    .from(npcFlag)
    .where(and(eq(npcFlag.memberId, memberId), eq(npcFlag.npcId, npcId)))
    .orderBy(asc(npcFlag.flag))
    .all();
  const rewards = db
    .select({ reward: npcReward.reward })
    .from(npcReward)
    .where(and(eq(npcReward.memberId, memberId), eq(npcReward.npcId, npcId)))
    .orderBy(asc(npcReward.reward))
    .all();
  return {
    npcId,
    ref: npcRefs(db, ctx.gameId, [npcId]).get(npcId)!,
    ...displayName(ctx, bond),
    baseGrade: ctx.baseGrade,
    grade: bond?.evolvedGrade ?? ctx.baseGrade,
    evolved: Boolean(bond?.evolvedGrade),
    alignment: bond?.evolvedAlignment ?? null,
    affinity: bond?.affinity ?? 0,
    companion: bond?.companionSeq !== null && bond?.companionSeq !== undefined,
    flags: Object.fromEntries(flags.map((f) => [f.flag, f.count])),
    rewards: rewards.map((r) => r.reward),
  };
}

// --- Companions (player routes) ---

export type CompanionOutcome =
  | { kind: 'ok'; companions: CompanionView[] }
  | { kind: 'gm_has_no_character' }
  | { kind: 'not_placed' }
  | { kind: 'npc_not_found'; message: string }
  | { kind: 'already_companion' }
  | { kind: 'not_acquainted' }
  | { kind: 'companion_limit' };

function savedBonds(db: DbOrTx, memberId: string) {
  return db
    .select()
    .from(npcBond)
    .where(and(eq(npcBond.memberId, memberId), isNotNull(npcBond.companionSeq)))
    .all();
}

/** The player's saved NPCs, main (highest affinity, tie = saved first) first. */
export function companionsOf(db: DbOrTx, assets: GameAssets, me: MemberRow): CompanionOutcome {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  const slots = savedBonds(db, me.id).flatMap((b) => {
    const ctx = contextFor(db, assets, me.id, b.npcId);
    return ctx ? [{ npcId: b.npcId, affinity: b.affinity, seq: b.companionSeq!, ctx, bond: b }] : [];
  });
  const { main, secondary } = rankCompanions(slots);
  const refs = npcRefs(db, me.gameId, slots.map((s) => s.npcId));
  const view = (s: (typeof slots)[number], role: CompanionView['role']): CompanionView => ({
    ref: refs.get(s.npcId)!,
    ...displayName(s.ctx, s.bond),
    role,
    bond: bondFor(s.affinity),
  });
  return { kind: 'ok', companions: [...(main ? [view(main, 'main')] : []), ...secondary.map((s) => view(s, 'secondary'))] };
}

/** Saves the NPC with `ref` at the player's place (at most 3; a 4th is refused until one is released). */
export function saveCompanion(db: DbOrTx, assets: GameAssets, me: MemberRow, ref: string, now: number): CompanionOutcome {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  const here = presenceOf(db, me.id);
  if (!here) return { kind: 'not_placed' };
  const npcId = npcIdForRef(db, me.gameId, ref);
  const npc = npcId ? npcsHereNow(db, assets, me.gameId, here.locationId, karmaNow(db, me.id)).find((n) => n.id === npcId) : undefined;
  if (!npcId || !npc) return { kind: 'npc_not_found', message: 'ไม่พบ NPC คนนี้ในที่ที่คุณอยู่' };
  const saved = savedBonds(db, me.id);
  if (saved.some((b) => b.npcId === npcId)) return { kind: 'already_companion' };
  const ctx = contextFor(db, assets, me.id, npcId)!;
  if (!displayName(ctx, bondOf(db, me.id, npcId)).nameRevealed) return { kind: 'not_acquainted' };
  if (saved.length >= COMPANION_LIMIT) return { kind: 'companion_limit' };
  const seq = Math.max(0, ...saved.map((b) => b.companionSeq!)) + 1;
  upsertBond(db, me.id, npcId, { companionSeq: seq }, now);
  return companionsOf(db, assets, me);
}

/** Releases one of the player's companions (the bond, affinity and name stay). */
export function releaseCompanion(db: DbOrTx, assets: GameAssets, me: MemberRow, ref: string, now: number): CompanionOutcome {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  const npcId = npcIdForRef(db, me.gameId, ref);
  if (!npcId || bondOf(db, me.id, npcId)?.companionSeq == null) return { kind: 'npc_not_found', message: 'NPC คนนี้ไม่ได้เป็นคู่หูของคุณ' };
  upsertBond(db, me.id, npcId, { companionSeq: null }, now);
  return companionsOf(db, assets, me);
}
