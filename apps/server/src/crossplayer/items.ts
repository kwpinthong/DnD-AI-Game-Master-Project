import type { LootOption } from '@isekai/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character, characterLoot, itemHolder, member } from '../db/schema.ts';
import type { StoredChosen } from '../game/loot.ts';

/**
 * Who holds which item (GEN-060), kept small on purpose until the inventory (GEN-055): every item is
 * the one a character chose in the loot step (GEN-048); `item_holder` overrides who holds it after a
 * steal or a gift. Skills and traits never change hands.
 */

export interface HeldItem extends LootOption {
  /** The member holding it now. */
  holderMemberId: string;
}

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
  return items;
}

export function heldItemsOf(db: DbOrTx, gameId: string, memberId: string): HeldItem[] {
  return [...itemsInGame(db, gameId).values()].filter((i) => i.holderMemberId === memberId);
}

/** Gives `itemId` to `toMemberId` (steal / give). The item must already be in the game. */
export function transferItem(db: DbOrTx, gameId: string, itemId: string, toMemberId: string, now: number): void {
  db.insert(itemHolder)
    .values({ itemId, gameId, holderMemberId: toMemberId, updatedAt: now })
    .onConflictDoUpdate({ target: itemHolder.itemId, set: { holderMemberId: toMemberId, updatedAt: now } })
    .run();
}
