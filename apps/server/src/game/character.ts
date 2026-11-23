import type { AppearanceTraits, CharacterRequest, CharacterView } from '@isekai/protocol';
import { karmaTitle, socialTitle, STARTING_STATS, type KarmaTier } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import type { Clock } from '../auth/join.ts';
import type { Db } from '../db/client.ts';
import { character } from '../db/schema.ts';
import { curseLabelsOf } from '../statuses/curses.ts';
import type { Looks } from './appearance.ts';
import { setupLocked } from './late-join.ts';
import { clearLoot, keptTraits } from './loot.ts';
import type { MemberRow } from './service.ts';

type CharacterRow = typeof character.$inferSelect;

/**
 * The title others and the player see (GEN-065): the start scenario's Initial_Title while Reputation is still in
 * the band it starts in, then the Social Title of the Reputation (Rules Spec §5).
 */
export function titleOf(row: Pick<CharacterRow, 'reputation' | 'initialTitle'>): string {
  const title = socialTitle(row.reputation);
  return row.initialTitle !== null && title === socialTitle(0) ? row.initialTitle : title;
}

/** What the player sees of their own character: no Karma or Reputation number; their own Karma word (GEN-067). */
function toView(row: CharacterRow, locked: boolean, karmaTiers: readonly KarmaTier[], statuses: string[] = [], traits: Pick<CharacterView, 'strength' | 'weakness'> = { strength: null, weakness: null }): CharacterView {
  return {
    ...traits,
    name: row.name,
    appearance: row.appearance,
    personality: row.personality,
    avatarId: row.avatarId,
    appearanceTraits: row.appearanceTraits === null ? null : (JSON.parse(row.appearanceTraits) as AppearanceTraits),
    hp: { current: row.hp, max: row.hpMax },
    stamina: { current: row.stamina, max: row.staminaMax },
    coins: row.coins,
    socialTitle: titleOf(row),
    conduct: karmaTitle(row.karma, karmaTiers),
    statuses,
    editable: !locked,
  };
}

/** ISK-006: the sentence is built once here and stored; a later chip label edit leaves it as it is. */
const stored = (looks: Looks) => ({ appearance: looks.appearance, avatarId: looks.avatarId, appearanceTraits: JSON.stringify(looks.appearanceTraits) });

export type CharacterOutcome =
  | { kind: 'ok'; character: CharacterView }
  | { kind: 'gm_has_no_character' }
  | { kind: 'character_exists' }
  | { kind: 'character_not_found' }
  | { kind: 'game_started' };

export function getCharacter(db: Db, me: MemberRow, karmaTiers: readonly KarmaTier[]): CharacterView | null {
  const row = db.select().from(character).where(eq(character.memberId, me.id)).get();
  // GEN-095: timed statuses as words only.
  return row ? toView(row, setupLocked(db, me), karmaTiers, curseLabelsOf(db, me.gameId, me.id), keptTraits(db, me.id, row.name)) : null;
}

/**
 * Creates the caller's character with the starting stats. One per member (the primary key), so
 * one per player per game; the Human GM has none (Q-059).
 */
export function createCharacter(db: Db, me: MemberRow, input: CharacterRequest, looks: Looks, now: Clock, karmaTiers: readonly KarmaTier[]): CharacterOutcome {
  if (me.role === 'gm') return { kind: 'gm_has_no_character' };
  return db.transaction((tx) => {
    if (setupLocked(tx, me)) return { kind: 'game_started' };
    // better-sqlite3 transactions run one at a time, so this check cannot race another create.
    const existing = tx.select({ memberId: character.memberId }).from(character).where(eq(character.memberId, me.id)).get();
    if (existing) return { kind: 'character_exists' };
    const t = now();
    const row: CharacterRow = {
      memberId: me.id,
      createdAt: t,
      updatedAt: t,
      name: input.name,
      personality: input.personality,
      ...stored(looks),
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
export function updateCharacter(db: Db, me: MemberRow, input: CharacterRequest, looks: Looks, now: Clock, karmaTiers: readonly KarmaTier[]): CharacterOutcome {
  return db.transaction((tx) => {
    const existing = tx.select().from(character).where(eq(character.memberId, me.id)).get();
    if (!existing) return { kind: 'character_not_found' };
    if (setupLocked(tx, me)) return { kind: 'game_started' };
    const identity = { name: input.name, personality: input.personality, ...stored(looks), updatedAt: now() };
    tx.update(character).set(identity).where(eq(character.memberId, me.id)).run();
    if (input.personality !== existing.personality) clearLoot(tx, me.id, identity.updatedAt);
    return { kind: 'ok', character: toView({ ...existing, ...identity }, false, karmaTiers, [], keptTraits(tx, me.id, input.name)) };
  });
}
