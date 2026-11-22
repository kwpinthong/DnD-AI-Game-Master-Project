import type { CharacterRequest, CharacterView } from '@isekai/protocol';
import { karmaTitle, socialTitle, STARTING_STATS, type KarmaTier } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { Clock } from '../auth/join.ts';
import type { Db } from '../db/client.ts';
import { character, game } from '../db/schema.ts';
import { clearLoot } from './loot.ts';
import type { MemberRow } from './service.ts';

type CharacterRow = typeof character.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The title others and the player see (GEN-065): the start scenario's Initial_Title while Reputation is still in
 * the band it starts in, then the Social Title of the Reputation (Rules Spec §5).
 */
export function titleOf(row: Pick<CharacterRow, 'reputation' | 'initialTitle'>): string {
  const title = socialTitle(row.reputation);
  return row.initialTitle !== null && title === socialTitle(0) ? row.initialTitle : title;
}

/** What the player sees of their own character: no Karma or Reputation number; their own Karma word (GEN-067). */
function toView(row: CharacterRow, gameStarted: boolean, karmaTiers: readonly KarmaTier[]): CharacterView {
  return {
    name: row.name,
    appearance: row.appearance,
    personality: row.personality,
    hp: { current: row.hp, max: row.hpMax },
    stamina: { current: row.stamina, max: row.staminaMax },
    coins: row.coins,
    socialTitle: titleOf(row),
    conduct: karmaTitle(row.karma, karmaTiers),
    editable: !gameStarted,
  };
}

export type CharacterOutcome =
  | { kind: 'ok'; character: CharacterView }
  | { kind: 'gm_has_no_character' }
  | { kind: 'character_exists' }
  | { kind: 'character_not_found' }
  | { kind: 'game_started' };

function gameStarted(db: Db | Tx, gameId: string): boolean {
  const row = db.select({ startedAt: game.startedAt }).from(game).where(eq(game.id, gameId)).get();
  return (row?.startedAt ?? null) !== null;
}

export function getCharacter(db: Db, me: MemberRow, karmaTiers: readonly KarmaTier[]): CharacterView | null {
  const row = db.select().from(character).where(eq(character.memberId, me.id)).get();
  return row ? toView(row, gameStarted(db, me.gameId), karmaTiers) : null;
}

/**
 * Creates the caller's character with the starting stats. One per member (the primary key), so
 * one per player per game; the Human GM has none (Q-059).
 */
export function createCharacter(db: Db, me: MemberRow, input: CharacterRequest, now: Clock, karmaTiers: readonly KarmaTier[]): CharacterOutcome {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  return db.transaction((tx) => {
    if (gameStarted(tx, me.gameId)) return { kind: 'game_started' };
    // better-sqlite3 transactions run one at a time, so this check cannot race another create.
    const existing = tx.select({ memberId: character.memberId }).from(character).where(eq(character.memberId, me.id)).get();
    if (existing) return { kind: 'character_exists' };
    const t = now();
    const row: CharacterRow = {
      memberId: me.id,
      createdAt: t,
      updatedAt: t,
      name: input.name,
      appearance: input.appearance,
      personality: input.personality,
      ...STARTING_STATS,
      // The start scenario sets the real starting numbers and title at game start (GEN-065).
      coins: 0,
      initialTitle: null,
    };
    tx.insert(character).values(row).run();
    return { kind: 'ok', character: toView(row, false, karmaTiers) };
  });
}

/**
 * Changes the identity only, and only before the game starts; the stats are not touched. A new
 * personality clears the loot built from the old one (Q-081); name / appearance keep it.
 */
export function updateCharacter(db: Db, me: MemberRow, input: CharacterRequest, now: Clock, karmaTiers: readonly KarmaTier[]): CharacterOutcome {
  return db.transaction((tx) => {
    const existing = tx.select().from(character).where(eq(character.memberId, me.id)).get();
    if (!existing) return { kind: 'character_not_found' };
    if (gameStarted(tx, me.gameId)) return { kind: 'game_started' };
    const identity = { name: input.name, appearance: input.appearance, personality: input.personality, updatedAt: now() };
    tx.update(character).set(identity).where(eq(character.memberId, me.id)).run();
    if (input.personality !== existing.personality) clearLoot(tx, me.id, identity.updatedAt);
    return { kind: 'ok', character: toView({ ...existing, ...identity }, false, karmaTiers) };
  });
}
