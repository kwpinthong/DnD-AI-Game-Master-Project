import type { NpcLineView, PlaceView, RoomEntry } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import { npcSpeaker } from '../companions/store.ts';
import type { DbOrTx } from '../db/client.ts';
import { character } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { ASTRAL_PLANE } from '../visibility/store.ts';
import type { GameAssets } from '../assets/load.ts';
import { placeMap, placeOfPresence, zoneView } from '../travel/rules.ts';
import type { EntryMeta, RoomEntryRow } from './store.ts';

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

/** A stored feed / narration / whisper / hit entry as `viewer` receives it, live, on replay and in the game log (GEN-037). */
export function entryViewOf(db: DbOrTx, row: RoomEntryRow, viewer: { id: string }, assets: GameAssets): RoomEntry {
  const meta = row.meta === null ? {} : (JSON.parse(row.meta) as EntryMeta);
  return {
    seq: row.id,
    kind: row.kind,
    day: row.day,
    phase: row.phase,
    turn: row.turn === 2 ? 2 : 1,
    place: placeViewOf(db, row.gameId, row.locationId, assets),
    text: row.text,
    // Q-229: the viewer's own roll / hit card; only the entries made for one reader carry them.
    ...(meta.roll ? { roll: meta.roll } : {}),
    ...(meta.hit ? { hit: meta.hit } : {}),
    ...(meta.changes ? { changes: [...meta.changes] } : {}),
    // GEN-110: who says the line, as this viewer may know them (alias until the name is learned, grade only then).
    ...(row.kind === 'npc' && meta.npc ? npcOf(db, meta.npc, viewer.id, assets) : {}),
    ...(row.kind === 'whisper'
      ? { whisper: { from: characterNameOf(db, row.fromMemberId), to: characterNameOf(db, row.toMemberId), mine: row.fromMemberId === viewer.id } }
      : {}),
    // Q-177: players learn only that it is the template, never why.
    ...(row.fallback !== null ? { fallback: true as const } : {}),
  };
}
