import type { LootOption } from '@isekai/protocol';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character, characterLoot, itemHolder, member, npcReward, ownedSkill } from '../db/schema.ts';
import type { StoredChosen, StoredOption } from '../game/loot.ts';

/**
 * Who owns which skill and holds which item (GEN-060, GEN-055). Items: the one a character chose in the loot
 * step (GEN-048) and the NPC rewards (GEN-054 `npc_reward`); `item_holder` overrides who holds one after a steal
 * or a gift. Skills: the loot skill, the NPC rewards and the unlocked ones (`owned_skill`); they never change
 * hands. A sheet row's numbers and text are read by name from the game data (`assets.ability` / `assets.item`).
 */

export type HeldItem = StoredOption & {
  /** The member holding it now. */
  holderMemberId: string;
};

export interface LootOfMember {
  memberId: string;
  chosen: StoredChosen | null;
}

/** Each active member's chosen loot (null = loot step not finished). */
export function chosenLootInGame(db: DbOrTx, gameId: string): LootOfMember[] {
  return db
    .select({ memberId: character.memberId, chosenJson: characterLoot.chosenJson })
    .from(character)
    .innerJoin(member, eq(member.id, character.memberId))
    .leftJoin(characterLoot, eq(characterLoot.memberId, character.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt)))
    .all()
    .map((r) => ({ memberId: r.memberId, chosen: r.chosenJson ? (JSON.parse(r.chosenJson) as StoredChosen) : null }));
}

/** An NPC reward as an owned option: the sheet row is read by `name`; the id is stable per player, NPC and reward. */
function rewardOption(memberId: string, npcId: string, name: string, kind: 'skill' | 'item'): LootOption {
  return { id: `reward:${memberId}:${npcId}:${name}`, kind, name, description: '', rank: null, triggerType: null, dailyLimit: 0, verbTags: [], targetTags: [], effects: [] };
}

function rewardsInGame(db: DbOrTx, gameId: string, kind: 'skill' | 'item') {
  return db
    .select({ memberId: npcReward.memberId, npcId: npcReward.npcId, reward: npcReward.reward })
    .from(npcReward)
    .innerJoin(member, eq(member.id, npcReward.memberId))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt), eq(npcReward.kind, kind)))
    .orderBy(asc(npcReward.grantedAt), asc(npcReward.npcId), asc(npcReward.reward))
    .all();
}

/** Every item in the game with its current holder. */
export function itemsInGame(db: DbOrTx, gameId: string): Map<string, HeldItem> {
  const holders = new Map(
    db.select().from(itemHolder).where(eq(itemHolder.gameId, gameId)).all().map((r) => [r.itemId, r.holderMemberId]),
  );
  const items = new Map<string, HeldItem>();
  for (const { memberId, chosen } of chosenLootInGame(db, gameId)) {
    if (!chosen) continue;
    items.set(chosen.item.id, { ...chosen.item, holderMemberId: holders.get(chosen.item.id) ?? memberId });
  }
  for (const r of rewardsInGame(db, gameId, 'item')) {
    const option = rewardOption(r.memberId, r.npcId, r.reward, 'item');
    items.set(option.id, { ...option, holderMemberId: holders.get(option.id) ?? r.memberId });
  }
  return items;
}

export function heldItemsOf(db: DbOrTx, gameId: string, memberId: string): HeldItem[] {
  return [...itemsInGame(db, gameId).values()].filter((i) => i.holderMemberId === memberId);
}

/** Each active member's skills, each name once: the loot skill, then the unlocked ones, then the NPC rewards. */
export function skillsInGame(db: DbOrTx, gameId: string): Map<string, StoredOption[]> {
  const out = new Map<string, StoredOption[]>();
  const add = (memberId: string, option: StoredOption) => {
    const list = out.get(memberId) ?? [];
    if (!list.some((o) => o.name === option.name)) out.set(memberId, [...list, option]);
  };
  for (const { memberId, chosen } of chosenLootInGame(db, gameId)) {
    out.set(memberId, []);
    if (chosen) add(memberId, chosen.skill);
  }
  const unlocked = db.select().from(ownedSkill).where(eq(ownedSkill.gameId, gameId)).orderBy(asc(ownedSkill.createdAt), sql`owned_skill.rowid`).all();
  for (const r of unlocked) if (out.has(r.memberId)) add(r.memberId, { ...rewardOption(r.memberId, 'unlock', r.name, 'skill'), id: `unlock:${r.memberId}:${r.name}` });
  for (const r of rewardsInGame(db, gameId, 'skill')) if (out.has(r.memberId)) add(r.memberId, rewardOption(r.memberId, r.npcId, r.reward, 'skill'));
  return out;
}

/** Gives `itemId` to `toMemberId` (steal / give). The item must already be in the game. */
export function transferItem(db: DbOrTx, gameId: string, itemId: string, toMemberId: string, now: number): void {
  db.insert(itemHolder)
    .values({ itemId, gameId, holderMemberId: toMemberId, updatedAt: now })
    .onConflictDoUpdate({ target: itemHolder.itemId, set: { holderMemberId: toMemberId, updatedAt: now } })
    .run();
}
