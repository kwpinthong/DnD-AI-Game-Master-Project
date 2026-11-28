import { isVotableEntry, type NpcLineView, type PlaceView, type RoomEntry } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import { npcSpeaker } from '../companions/store.ts';
import type { DbOrTx } from '../db/client.ts';
import { character, member } from '../db/schema.ts';
import { titleOf } from '../game/character.ts';
import { maskNames } from '../gm/check.ts';
import { getGameScenario } from '../scenario/store.ts';
import { ASTRAL_PLANE, namesVisibleTo, npcBondsOf } from '../visibility/store.ts';
import type { GameAssets } from '../assets/load.ts';
import { placeMap, placeOfPresence, zoneView } from '../travel/rules.ts';
import type { EntryMeta, RoomEntryRow } from './store.ts';
import { myVoteFields } from './vote.ts';

/** A scenario place as players see it (id + name + its zone when it is a Location row); null for no place (an Astral Spirit has none, GEN-070). */
export function placeViewOf(db: DbOrTx, gameId: string, locationId: string | null, assets: GameAssets): PlaceView | null {
  if (locationId === null || locationId === ASTRAL_PLANE) return null;
  const scenario = getGameScenario(db, gameId);
  const zone = placeOfPresence(placeMap(assets), scenario, locationId);
  return { id: locationId, name: scenario?.locations.find((l) => l.id === locationId)?.name ?? locationId, ...(zone ? { zone: zoneView(zone) } : {}) };
}

export function characterNameOf(db: DbOrTx, memberId: string | null): string {
  if (memberId === null) return '';
  return db.select({ name: character.name }).from(character).where(eq(character.memberId, memberId)).get()?.name ?? '';
}

function npcOf(db: DbOrTx, npc: NonNullable<EntryMeta['npc']>, viewerId: string, assets: GameAssets): { npc: NpcLineView } | Record<string, never> {
  const speaker = npcSpeaker(db, assets, viewerId, npc.id);
  return speaker ? { npc: { ...speaker, kind: npc.kind, ...(npc.private ? { private: true as const } : {}) } } : {};
}

/** GEN-129: the actor of a `player` entry as `viewer` may know them: the real name for the Human GM and for a person they know (GEN-117), else the Social Title. */
function actorOf(db: DbOrTx, memberId: string, viewer: { id: string; role: string }): { actor: { name: string } } {
  const c = db.select().from(character).where(eq(character.memberId, memberId)).get();
  if (!c) return { actor: { name: '' } };
  return { actor: { name: viewer.role === 'gm' || namesVisibleTo(db, viewer.id).has(memberId) ? c.name : titleOf(c) } };
}

/**
 * GEN-154: the action as typed, with each real name `viewer` does not know (another player's, an NPC's) swapped for
 * the alias they would see. Not for the Human GM nor the actor; the actor's own name stays (an introduction, GEN-117).
 */
function playerTextOf(db: DbOrTx, row: RoomEntryRow, actorId: string, viewer: { id: string; role: string }): string {
  if (viewer.role === 'gm' || viewer.id === actorId) return row.text;
  const known = namesVisibleTo(db, viewer.id);
  const aliases = new Map<string, string>();
  const people = db.select({ c: character }).from(character).innerJoin(member, eq(member.id, character.memberId)).where(eq(member.gameId, row.gameId)).all();
  for (const { c } of people) {
    if (c.memberId !== actorId && c.memberId !== viewer.id && !known.has(c.memberId) && c.name.trim().length > 0) aliases.set(c.name, titleOf(c));
  }
  const revealed = new Set(npcBondsOf(db, viewer.id).filter((b) => b.nameRevealed).map((b) => b.npcId));
  for (const n of getGameScenario(db, row.gameId)?.npcs ?? []) {
    if (!revealed.has(n.id) && n.name.trim().length > 0 && n.name !== n.alias) aliases.set(n.name, n.alias);
  }
  return aliases.size === 0 ? row.text : maskNames(row.text, aliases);
}

/** A stored feed / narration / whisper / hit entry as `viewer` receives it, live, on replay and in the game log (GEN-037). */
export function entryViewOf(db: DbOrTx, row: RoomEntryRow, viewer: { id: string; role: string }, assets: GameAssets): RoomEntry {
  const meta = row.meta === null ? {} : (JSON.parse(row.meta) as EntryMeta);
  return {
    seq: row.id,
    kind: row.kind,
    day: row.day,
    phase: row.phase,
    turn: row.turn === 2 ? 2 : 1,
    place: placeViewOf(db, row.gameId, row.locationId, assets),
    text: row.kind === 'player' && meta.actor ? playerTextOf(db, row, meta.actor, viewer) : row.text,
    // Q-229: the viewer's own roll / hit card; only the entries made for one reader carry them.
    ...(meta.roll ? { roll: meta.roll } : {}),
    ...(meta.hit ? { hit: meta.hit } : {}),
    ...(meta.changes ? { changes: [...meta.changes] } : {}),
    ...(meta.clue ? { clue: true as const } : {}),
    // GEN-110: who says the line, as this viewer may know them (alias until the name is learned, grade only then).
    ...(row.kind === 'npc' && meta.npc ? npcOf(db, meta.npc, viewer.id, assets) : {}),
    ...(row.kind === 'player' && meta.actor ? actorOf(db, meta.actor, viewer) : {}),
    ...(row.kind === 'whisper'
      ? { whisper: { from: characterNameOf(db, row.fromMemberId), to: characterNameOf(db, row.toMemberId), mine: row.fromMemberId === viewer.id } }
      : {}),
    // Q-177: players learn only that it is the template, never why.
    ...(row.fallback !== null ? { fallback: true as const } : {}),
    // GEN-107: only a player sees the buttons, and only on what the AI GM wrote.
    ...(viewer.role === 'player' && isVotableEntry(row) && !meta.clue ? myVoteFields(db, row.gameId, viewer.id, row.id) : {}),
  };
}
