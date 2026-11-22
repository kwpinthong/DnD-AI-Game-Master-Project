import type { GameReveal } from '@isekai/protocol';
import { karmaTitle } from '@isekai/rules';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, characterPresence, member } from '../db/schema.ts';
import { companionIdsOf } from '../gm/finale.ts';
import { rulingsOf } from '../rating/store.ts';
import { getGameScenario } from '../scenario/store.ts';
import { getEnding } from './store.ts';

/**
 * The secret reveal of an ended game (GEN-059 C5): every player's real name, karma (Q-196: tier word +
 * number), Secret actions, companions, spawn point and ending outcome. The caller makes sure the game
 * ended: before that, none of it may reach a player.
 */
export function revealFor(db: DbOrTx, assets: GameAssets, gameId: string): GameReveal {
  const ending = getEnding(db, gameId);
  const scenario = getGameScenario(db, gameId);
  const placeName = new Map((scenario?.locations ?? []).map((l) => [l.id, l.name]));
  const npcName = new Map((scenario?.npcs ?? []).map((n) => [n.id, n.name]));
  const rows = db
    .select({ memberId: member.id, lobbyName: member.name, characterName: character.name, karma: character.karma, spawn: characterPresence.spawnLocationId })
    .from(member)
    .innerJoin(character, eq(character.memberId, member.id))
    .leftJoin(characterPresence, eq(characterPresence.memberId, member.id))
    .where(and(eq(member.gameId, gameId), isNull(member.kickedAt), eq(member.role, 'player')))
    // rowid breaks ties in insert order, as `activeMembers` does.
    .orderBy(asc(member.createdAt), sql`member.rowid`)
    .all();
  // GEN-078: each carries the `sourceRef` a 👍 names; oldest first.
  const secrets = rulingsOf(db, gameId).filter((r) => r.visibility === 'secret');
  return {
    path: ending?.path ?? null,
    players: rows.map((r) => ({
      memberId: r.memberId,
      lobbyName: r.lobbyName,
      characterName: r.characterName,
      karma: r.karma,
      karmaTier: karmaTitle(r.karma, assets.karmaTiers),
      outcome: ending?.outcomes[r.memberId] ?? null,
      spawn: r.spawn === null ? null : (placeName.get(r.spawn) ?? r.spawn),
      companions: companionIdsOf(db, r.memberId).map((id) => npcName.get(id) ?? id),
      secretActions: secrets.filter((s) => s.memberId === r.memberId).map((s) => ({ day: s.day, phase: s.phase, turn: s.turn === 2 ? 2 : 1, text: s.text, sourceRef: s.sourceRef })),
    })),
  };
}
