import { isVotableEntry, type PlaceView, type RoomEntry } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import { ASTRAL_PLANE } from '../visibility/store.ts';
import type { GameAssets } from '../assets/load.ts';
import { placeMap, placeOfPresence, zoneView } from '../travel/rules.ts';
import type { EntryMeta, RoomEntryRow } from './store.ts';
import { myVoteOf } from './vote.ts';

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
    text: row.text,
    // Q-229: the viewer's own roll / hit card; only the entries made for one reader carry them.
    ...(meta.roll ? { roll: meta.roll } : {}),
    ...(meta.hit ? { hit: meta.hit } : {}),
    ...(meta.changes ? { changes: [...meta.changes] } : {}),
    ...(row.kind === 'whisper'
      ? { whisper: { from: characterNameOf(db, row.fromMemberId), to: characterNameOf(db, row.toMemberId), mine: row.fromMemberId === viewer.id } }
      : {}),
    // Q-177: players learn only that it is the template, never why.
    ...(row.fallback !== null ? { fallback: true as const } : {}),
    // GEN-107: only a player sees the buttons, and only on what the AI GM wrote.
    ...(viewer.role === 'player' && isVotableEntry(row) ? { myVote: myVoteOf(db, row.gameId, viewer.id, row.id) } : {}),
  };
}
