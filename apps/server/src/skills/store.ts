import type { InventoryEntry, InventoryView } from '@isekai/protocol';
import { unlockPath, type OwnedSkillFact, type Period, type SkillProgress, type SkillRank } from '@isekai/rules';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import { grantNpcReward, observeKarma } from '../companions/store.ts';
import { heldItemsOf, skillsInGame } from '../crossplayer/items.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, karmaDay, member, ownedSkill, skillActivity, skillFlag, skillReveal } from '../db/schema.ts';
import type { MemberRow } from '../game/service.ts';
import { isLegacyOption, type StoredOption } from '../game/loot.ts';
import { SKILL_FLAGS, UNLOCK_RULES } from './unlock-rules.ts';

/**
 * Skills and items of the Asset sheet for one player (GEN-055). A player's skills are the loot skill, the NPC
 * rewards (GEN-054 `npc_reward`) and the unlocked ones (`owned_skill`); their items the loot item and the NPC
 * reward items, wherever `item_holder` says they are now (`crossplayer/items.ts`).
 *
 * The AI GM loop (GEN-057) calls `grantSkill` / `grantItem` / `recordSkillFlag`; the server itself counts the
 * activities of each turn (`progress.ts`) and unlocks a skill as soon as one of its paths holds (`UNLOCK_RULES`).
 * Every call that would give nothing new changes nothing (C8). Players only read their own inventory
 * (`inventoryOf`), never a condition or its progress; INVESTIGATE at the library reveals one (`revealAtLibrary`).
 */

export interface SkillTime {
  /** Game day 1..12. */
  readonly day: number;
  readonly period: Period;
  readonly now: number;
}

export type SkillErrorCode = 'unknown_member' | 'unknown_skill' | 'unknown_item' | 'unknown_flag' | 'already_owned' | 'not_unlocked';
export interface SkillError {
  /** One of `SkillErrorCode`, or the GEN-054 code of an NPC refusal (`unknown_npc`, `not_in_rewards`, ...). */
  readonly code: string;
  readonly message: string;
}
type Fail = { ok: false; error: SkillError };
const fail = (code: string, message: string): Fail => ({ ok: false, error: { code, message } });

export type GrantResult = { ok: true; source: 'npc' | 'unlock'; unlocked: string[] } | Fail;

const gameOf = (db: DbOrTx, memberId: string) => db.select({ gameId: member.gameId }).from(member).where(eq(member.id, memberId)).get()?.gameId;

const ownedOf = (db: DbOrTx, gameId: string, memberId: string): StoredOption[] => skillsInGame(db, gameId).get(memberId) ?? [];

const isSkillRank = (rank: string): rank is SkillRank => rank !== 'F';

/** Everything the unlock rules read for one player (the AI GM and the Human GM only, never a player). */
export function skillProgressOf(db: DbOrTx, assets: GameAssets, memberId: string, day: number): SkillProgress {
  const gameId = gameOf(db, memberId);
  const karma = db.select({ karma: character.karma }).from(character).where(eq(character.memberId, memberId)).get()?.karma ?? 0;
  const skills: OwnedSkillFact[] = (gameId ? ownedOf(db, gameId, memberId) : []).flatMap((o) => {
    const row = assets.ability(o.name);
    return row && isSkillRank(row.rank) ? [{ name: row.name, rank: row.rank, alignment: row.alignment }] : [];
  });
  const flags = db.select({ flag: skillFlag.flag, count: skillFlag.count }).from(skillFlag).where(eq(skillFlag.memberId, memberId)).all();
  const activities = db
    .select({ activity: skillActivity.activity, day: skillActivity.day, period: skillActivity.period })
    .from(skillActivity)
    .where(eq(skillActivity.memberId, memberId))
    .all();
  const days = db.select().from(karmaDay).where(eq(karmaDay.memberId, memberId)).all();
  return {
    day,
    karma,
    skills,
    holding: gameId ? heldItemsOf(db, gameId, memberId).map((i) => i.name) : [],
    flags: Object.fromEntries(flags.map((f) => [f.flag, f.count])),
    activities,
    karmaDays: Object.fromEntries(days.map((d) => [d.day, { min: d.min, max: d.max }])),
  };
}

const owns = (db: DbOrTx, gameId: string, memberId: string, name: string) => ownedOf(db, gameId, memberId).some((o) => o.name === name);

function addSkill(db: DbOrTx, gameId: string, memberId: string, name: string, source: string, at: SkillTime): void {
  db.insert(ownedSkill).values({ memberId, gameId, name, source, day: at.day, createdAt: at.now }).onConflictDoNothing().run();
}

/** Unlocks every skill whose rule holds now (a new skill may open the next one); returns their names in order. */
export function checkSkillUnlocks(db: DbOrTx, assets: GameAssets, memberId: string, at: SkillTime): string[] {
  const gameId = gameOf(db, memberId);
  if (!gameId) return [];
  return db.transaction((tx) => {
    observeKarma(tx, memberId, at.day);
    const unlocked: string[] = [];
    for (;;) {
      const progress = skillProgressOf(tx, assets, memberId, at.day);
      const owned = new Set(ownedOf(tx, gameId, memberId).map((o) => o.name));
      const next = assets.abilities.flatMap((a) => {
        const rule = UNLOCK_RULES[a.name];
        const path = rule && !owned.has(a.name) ? unlockPath(rule, progress) : null;
        return path ? [{ name: a.name, source: path.source }] : [];
      })[0];
      if (!next) return unlocked;
      addSkill(tx, gameId, memberId, next.name, next.source, at);
      unlocked.push(next.name);
    }
  });
}

/** Counts `activity` for the player in `at.period` of `at.day` (once per period), then unlocks what now holds. */
export function recordSkillActivity(db: DbOrTx, assets: GameAssets, memberId: string, activity: string, at: SkillTime): string[] {
  if (!gameOf(db, memberId)) return [];
  db.insert(skillActivity).values({ memberId, activity, day: at.day, period: at.period, createdAt: at.now }).onConflictDoNothing().run();
  return checkSkillUnlocks(db, assets, memberId, at);
}

/** The AI GM judged an event of a condition (a flag of `UNLOCK_RULES`); each call adds one. Then unlocks what now holds. */
export function recordSkillFlag(db: DbOrTx, assets: GameAssets, memberId: string, flag: string, at: SkillTime): { ok: true; count: number; unlocked: string[] } | Fail {
  if (!SKILL_FLAGS.has(flag)) return fail('unknown_flag', `"${flag}" is not a condition flag of any skill`);
  if (!gameOf(db, memberId)) return fail('unknown_member', 'no such member');
  return db.transaction((tx) => {
    const row = tx
      .insert(skillFlag)
      .values({ memberId, flag, count: 1, day: at.day, updatedAt: at.now })
      .onConflictDoUpdate({ target: [skillFlag.memberId, skillFlag.flag], set: { count: sql`${skillFlag.count} + 1`, day: at.day, updatedAt: at.now } })
      .returning({ count: skillFlag.count })
      .get();
    return { ok: true as const, count: row.count, unlocked: checkSkillUnlocks(tx, assets, memberId, at) };
  });
}

/**
 * Gives the skill `name`. With `from`, the NPC gives it when it is in that NPC's Rewards and open for this player
 * (GEN-054); otherwise (or without an NPC) only when one of the skill's unlock paths holds now. A name that is not
 * an Ability row, a skill the player has, or unmet conditions are refused and nothing changes (C5, C8).
 */
export function grantSkill(db: DbOrTx, assets: GameAssets, memberId: string, name: string, at: SkillTime, from?: { npcId: string }): GrantResult {
  const gameId = gameOf(db, memberId);
  if (!gameId) return fail('unknown_member', 'no such member');
  const ability = assets.ability(name);
  if (!ability) return fail('unknown_skill', `"${name}" is not a skill of the game data`);
  if (owns(db, gameId, memberId, ability.name)) return fail('already_owned', `the player already has "${ability.name}"`);
  return db.transaction((tx): GrantResult => {
    let npcRefusal: SkillError | null = null;
    if (from) {
      const given = grantNpcReward(tx, assets, memberId, from.npcId, ability.name, at.now);
      if (given.ok) return { ok: true, source: 'npc', unlocked: checkSkillUnlocks(tx, assets, memberId, at) };
      if (given.error.code !== 'not_in_rewards' && given.error.code !== 'not_unlocked') return { ok: false, error: given.error };
      npcRefusal = given.error;
    }
    const rule = UNLOCK_RULES[ability.name];
    const path = rule ? unlockPath(rule, skillProgressOf(tx, assets, memberId, at.day)) : null;
    if (!path) return { ok: false, error: npcRefusal ?? { code: 'not_unlocked', message: `the conditions of "${ability.name}" do not hold yet` } };
    addSkill(tx, gameId, memberId, ability.name, path.source, at);
    return { ok: true, source: 'unlock', unlocked: checkSkillUnlocks(tx, assets, memberId, at) };
  });
}

/** Gives the item `name` from NPC `npcId`: only an item of that NPC's open Rewards, once (GEN-054). */
export function grantItem(db: DbOrTx, assets: GameAssets, memberId: string, name: string, npcId: string, at: SkillTime): { ok: true } | Fail {
  const item = assets.item(name);
  if (!item) return fail('unknown_item', `"${name}" is not an item of the game data`);
  if (!gameOf(db, memberId)) return fail('unknown_member', 'no such member');
  return db.transaction((tx): { ok: true } | Fail => {
    const given = grantNpcReward(tx, assets, memberId, npcId, item.nameEn, at.now);
    if (!given.ok) return { ok: false, error: given.error };
    // Holding it may complete an item path (Skill Synergy).
    checkSkillUnlocks(tx, assets, memberId, at);
    return { ok: true };
  });
}

/** The tag every library search uses itself: not a topic. */
const SEARCH_VERB = 'INVESTIGATE';

/**
 * INVESTIGATE at the library (หอสมุดหลวง Special Mechanics): reveals the condition of every skill / item whose
 * verb + target tags hold every topic tag (no topic, no reveal). Returns what matched; each is stored once.
 */
export function revealAtLibrary(db: DbOrTx, assets: GameAssets, memberId: string, topicTags: readonly string[], at: SkillTime): { kind: 'skill' | 'item'; name: string }[] {
  const topic = [...new Set(topicTags)].filter((t) => t !== SEARCH_VERB);
  if (topic.length === 0 || !gameOf(db, memberId)) return [];
  const fits = (r: { matchVerbTags: readonly string[]; matchTargetTags: readonly string[] }) => topic.every((t) => r.matchVerbTags.includes(t) || r.matchTargetTags.includes(t));
  const found = [
    ...assets.abilities.filter(fits).map((a) => ({ kind: 'skill' as const, name: a.name })),
    ...assets.items.filter(fits).map((i) => ({ kind: 'item' as const, name: i.nameEn })),
  ];
  for (const f of found) db.insert(skillReveal).values({ memberId, kind: f.kind, name: f.name, day: at.day, createdAt: at.now }).onConflictDoNothing().run();
  return found;
}

export type InventoryOutcome = { kind: 'ok'; inventory: InventoryView } | { kind: 'gm_has_no_character' };

function entryOf(o: StoredOption, assets: GameAssets): InventoryEntry {
  const row = isLegacyOption(o) ? undefined : o.kind === 'skill' ? assets.ability(o.name) : assets.item(o.name);
  if (!row) return { id: o.id, name: o.name, rank: null, alignment: null, category: '', triggerType: null, dailyLimit: 0, description: o.description };
  return {
    id: o.id,
    name: o.name,
    rank: isSkillRank(row.rank) ? row.rank : null,
    alignment: row.alignment,
    category: row.category,
    triggerType: row.triggerType,
    dailyLimit: row.dailyLimit,
    description: 'effect' in row ? row.effect : row.description,
  };
}

/** The caller's own skills, the items they hold now (after a steal / gift too, Q-106) and their library discoveries. */
export function inventoryOf(db: DbOrTx, assets: GameAssets, me: MemberRow): InventoryOutcome {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  const reveals = db
    .select({ kind: skillReveal.kind, name: skillReveal.name })
    .from(skillReveal)
    .where(and(eq(skillReveal.memberId, me.id)))
    .orderBy(asc(skillReveal.createdAt), sql`skill_reveal.rowid`)
    .all();
  return {
    kind: 'ok',
    inventory: {
      skills: ownedOf(db, me.gameId, me.id).map((o) => entryOf(o, assets)),
      items: heldItemsOf(db, me.gameId, me.id).map((o) => entryOf(o, assets)),
      discoveries: reveals.flatMap((r) => {
        const text = r.kind === 'skill' ? assets.ability(r.name)?.condition : assets.item(r.name)?.synergy;
        return text === undefined ? [] : [{ kind: r.kind, name: r.name, text }];
      }),
    },
  };
}
