import { isVotableEntry, type AdminUpvoteEntry, type NpcChoice, type NpcExampleAddRequest, type NpcLibraryResponse } from '@isekai/protocol';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { game, npcExample, responseCorrection, responseVote, roomEntry } from '../db/schema.ts';
import { exampleTokens } from '../gm/npc-examples.ts';
import { npcCandidates } from '../learning/examples.ts';
import type { EntryMeta, RoomEntryRow } from '../room/store.ts';
import { getGameScenario } from '../scenario/store.ts';
import { correctionView, memberNames, npcOf, sceneOf } from './vote-review.ts';

/**
 * GEN-151: the server owner's NPC example library: 👍 messages and "แก้เป็น" pairs given to an NPC with a scene
 * kind. Stored with tokens only (the game's NPC and player names swapped when added); the turn reads it live.
 */

const metaOf = (row: RoomEntryRow): EntryMeta => (row.meta === null ? {} : (JSON.parse(row.meta) as EntryMeta));
const scenarioNpcs = (db: DbOrTx, gameId: string) => (getGameScenario(db, gameId)?.npcs ?? []).map((n) => ({ id: n.id, name: n.name, names: [n.name, ...(n.otherNames ?? [])] }));

function upvoted(db: DbOrTx, inLibrary: ReadonlySet<string>): AdminUpvoteEntry[] {
  const ups = db.select().from(responseVote).where(and(eq(responseVote.vote, 'up'), like(responseVote.sourceRef, 'entry-%'))).all();
  const ids = [...new Set(ups.map((v) => Number(v.sourceRef.slice('entry-'.length))))];
  if (ids.length === 0) return [];
  const names = new Map(db.select({ id: game.id, name: game.name }).from(game).all().map((g) => [g.id, g.name]));
  return db
    .select()
    .from(roomEntry)
    .where(inArray(roomEntry.id, ids))
    .all()
    .sort((a, b) => b.id - a.id)
    .map((row) => {
      const meta = metaOf(row);
      return {
        gameId: row.gameId,
        gameName: names.get(row.gameId) ?? '',
        seq: row.id,
        scene: sceneOf(row, meta),
        npc: npcOf(db, row, meta),
        at: { day: row.day, phase: row.phase, turn: row.turn === 2 ? 2 : 1 },
        text: row.text,
        up: ups.filter((v) => v.gameId === row.gameId && v.sourceRef === `entry-${row.id}`).length,
        inLibrary: inLibrary.has(`${row.gameId}/${row.id}`),
      };
    })
    .filter((e) => e.up > 0);
}

export function npcLibrary(db: DbOrTx): NpcLibraryResponse {
  const rows = db.select().from(npcExample).orderBy(asc(npcExample.id)).all();
  const npcs = [...new Map(rows.map((r) => [r.npcId, r.npcName])).entries()].map(([npcId, npcName]) => ({
    npcId,
    npcName,
    examples: rows
      .filter((r) => r.npcId === npcId)
      .map((r) => ({ id: r.id, npcId, scene: r.scene, text: r.text, source: r.source, gameId: r.gameId, seq: r.entryId, createdAt: new Date(r.createdAt).toISOString() })),
  }));
  const added = new Set(rows.flatMap((r) => (r.correctionId === null ? [] : [r.correctionId])));
  const candidates = db.select().from(responseCorrection).where(eq(responseCorrection.libraryCandidate, true)).orderBy(asc(responseCorrection.id)).all().filter((c) => !added.has(c.id));
  const choices = new Map<string, NpcChoice>();
  for (const g of db.select({ id: game.id }).from(game).all()) for (const n of scenarioNpcs(db, g.id)) if (!choices.has(n.id)) choices.set(n.id, { id: n.id, name: n.name });
  return {
    npcs,
    upvoted: upvoted(db, new Set(rows.filter((r) => r.source === 'vote').map((r) => `${r.gameId}/${r.entryId}`))),
    candidates: candidates.map(correctionView),
    npcChoices: [...choices.values()],
    goodLines: npcCandidates(db),
  };
}

/** Adds one example (none twice); false = no such message / 👍 / pair, or an NPC its game does not have. */
export function addNpcExample(db: DbOrTx, input: NpcExampleAddRequest, now: number): boolean {
  if (input.from === 'vote') {
    const row = db.select().from(roomEntry).where(and(eq(roomEntry.id, input.seq), eq(roomEntry.gameId, input.gameId))).get();
    if (!row || !isVotableEntry(row)) return false;
    const up = db.select().from(responseVote).where(and(eq(responseVote.gameId, row.gameId), eq(responseVote.sourceRef, `entry-${row.id}`), eq(responseVote.vote, 'up'))).get();
    const npcs = scenarioNpcs(db, row.gameId);
    const npc = npcs.find((n) => n.id === input.npcId);
    if (!up || !npc) return false;
    const same = db.select({ id: npcExample.id }).from(npcExample).where(and(eq(npcExample.source, 'vote'), eq(npcExample.gameId, row.gameId), eq(npcExample.entryId, row.id), eq(npcExample.npcId, npc.id))).get();
    if (!same) {
      const text = exampleTokens(row.text, npcs, memberNames(db, row.gameId).flat());
      db.insert(npcExample).values({ npcId: npc.id, npcName: npc.name, scene: input.scene, text, source: 'vote', gameId: row.gameId, entryId: row.id, correctionId: null, createdAt: now }).run();
    }
    return true;
  }
  const pair = db.select().from(responseCorrection).where(eq(responseCorrection.id, input.correctionId)).get();
  if (!pair) return false;
  const entry = db.select().from(roomEntry).where(and(eq(roomEntry.id, pair.entryId), eq(roomEntry.gameId, pair.gameId))).get();
  const npcId = input.npcId ?? (entry ? npcOf(db, entry, metaOf(entry))?.id : undefined);
  const npcs = scenarioNpcs(db, pair.gameId);
  const npc = npcs.find((n) => n.id === npcId);
  if (!npc) return false;
  if (!db.select({ id: npcExample.id }).from(npcExample).where(eq(npcExample.correctionId, pair.id)).get()) {
    // Q-337: Nok's edited version, not the AI's.
    const text = exampleTokens(pair.edited, npcs, (JSON.parse(pair.playerNames) as string[][]).flat());
    db.insert(npcExample).values({ npcId: npc.id, npcName: npc.name, scene: pair.scene, text, source: 'correction', gameId: pair.gameId, entryId: pair.entryId, correctionId: pair.id, createdAt: now }).run();
  }
  return true;
}

/** C5: false = no such example. */
export function deleteNpcExample(db: DbOrTx, id: number): boolean {
  return db.delete(npcExample).where(eq(npcExample.id, id)).run().changes > 0;
}
