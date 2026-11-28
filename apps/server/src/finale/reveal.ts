import type { GameReveal } from '@isekai/protocol';
import { karmaTitle } from '@isekai/rules';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { GameAssets } from '../assets/load.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, characterPresence, member, roomEntry, roomEntryRecipient } from '../db/schema.ts';
import { titleOf } from '../game/character.ts';
import { companionIdsOf } from '../gm/finale.ts';
import { rulingsOf } from '../rating/store.ts';
import { ownEndingText } from '../room/entry-view.ts';
import { getGameScenario } from '../scenario/store.ts';
import { getEnding } from './store.ts';

/**
 * The secret reveal of an ended game (GEN-059 C5): every player's real name, karma (Q-196: tier word +
 * number), Secret actions, companions, spawn point and ending outcome. The caller makes sure the game
 * ended: before that, none of it may reach a player. `viewerId`: their own epilogue reads like their log (ISK-008).
 */
export function revealFor(db: DbOrTx, assets: GameAssets, gameId: string, viewerId?: string): GameReveal {
  const ending = getEnding(db, gameId);
  const scenario = getGameScenario(db, gameId);
  const placeName = new Map((scenario?.locations ?? []).map((l) => [l.id, l.name]));
  const npcName = new Map((scenario?.npcs ?? []).map((n) => [n.id, n.name]));
  /** The ending the GM told this player (the last narration of the finale); null = not told yet. */
  const epilogueOf = (memberId: string) => {
    const text = db
      .select({ text: roomEntry.text })
      .from(roomEntry)
      .innerJoin(roomEntryRecipient, eq(roomEntryRecipient.entryId, roomEntry.id))
      .where(and(eq(roomEntry.gameId, gameId), eq(roomEntry.kind, 'narration'), eq(roomEntryRecipient.memberId, memberId), sql`json_extract(${roomEntry.meta}, '$.finale') = 1`))
      .orderBy(desc(roomEntry.id))
      .get()?.text ?? null;
    return text !== null && memberId === viewerId ? ownEndingText(db, gameId, text, { id: memberId, role: 'player' }, assets) : text;
  };
  const rows = db
    .select({
      memberId: member.id,
      lobbyName: member.name,
      characterName: character.name,
      karma: character.karma,
      appearance: character.appearance,
      title: { reputation: character.reputation, initialTitle: character.initialTitle },
      spawn: characterPresence.spawnLocationId,
    })
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
      appearance: r.appearance,
      finalTitle: titleOf(r.title),
      epilogue: epilogueOf(r.memberId),
      karmaTier: karmaTitle(r.karma, assets.karmaTiers),
      outcome: ending?.outcomes[r.memberId] ?? null,
      spawn: r.spawn === null ? null : (placeName.get(r.spawn) ?? r.spawn),
      companions: companionIdsOf(db, r.memberId).map((id) => npcName.get(id) ?? id),
      secretActions: secrets.filter((s) => s.memberId === r.memberId).map((s) => ({ day: s.day, phase: s.phase, turn: s.turn === 2 ? 2 : 1, text: s.text, sourceRef: s.sourceRef })),
    })),
  };
}
