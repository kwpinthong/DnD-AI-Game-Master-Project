import type { CharacterRequest, CharacterView } from '@isekai/protocol';
import { socialTitle, STARTING_STATS } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { Clock } from '../auth/join.ts';
import type { Db } from '../db/client.ts';
import { character, game } from '../db/schema.ts';
import { clearLoot } from './loot.ts';
import type { MemberRow } from './service.ts';

type CharacterRow = typeof character.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** What the player sees of their own character: no Karma, no Reputation number. */
function toView(row: CharacterRow, gameStarted: boolean): CharacterView {
  return {
    name: row.name,
    appearance: row.appearance,
    personality: row.personality,
    hp: { current: row.hp, max: row.hpMax },
    stamina: { current: row.stamina, max: row.staminaMax },
    socialTitle: socialTitle(row.reputation),
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

export function getCharacter(db: Db, me: MemberRow): CharacterView | null {
  const row = db.select().from(character).where(eq(character.memberId, me.id)).get();
  return row ? toView(row, gameStarted(db, me.gameId)) : null;
}

/**
 * Creates the caller's character with the starting stats. One per member (the primary key), so
 * one per player per game; the Human GM has none (Q-059).
 */
export function createCharacter(db: Db, me: MemberRow, input: CharacterRequest, now: Clock): CharacterOutcome {
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
    };
    tx.insert(character).values(row).run();
    return { kind: 'ok', character: toView(row, false) };
  });
}

/**
 * Changes the identity only, and only before the game starts; the stats are not touched. A new
 * personality clears the loot built from the old one (Q-081); name / appearance keep it.
 */
export function updateCharacter(db: Db, me: MemberRow, input: CharacterRequest, now: Clock): CharacterOutcome {
  return db.transaction((tx) => {
    const existing = tx.select().from(character).where(eq(character.memberId, me.id)).get();
    if (!existing) return { kind: 'character_not_found' };
    if (gameStarted(tx, me.gameId)) return { kind: 'game_started' };
    const identity = { name: input.name, appearance: input.appearance, personality: input.personality, updatedAt: now() };
    tx.update(character).set(identity).where(eq(character.memberId, me.id)).run();
    if (input.personality !== existing.personality) clearLoot(tx, me.id, identity.updatedAt);
    return { kind: 'ok', character: toView({ ...existing, ...identity }, false) };
  });
}
