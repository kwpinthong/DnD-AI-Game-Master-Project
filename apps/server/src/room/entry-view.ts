import type { PlaceView, RoomEntry } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { character } from '../db/schema.ts';
import { getGameScenario } from '../scenario/store.ts';
import type { RoomEntryRow } from './store.ts';

/** A scenario place as players see it (id + name); null for no place. */
export function placeViewOf(db: DbOrTx, gameId: string, locationId: string | null): PlaceView | null {
  if (locationId === null) return null;
  const location = getGameScenario(db, gameId)?.locations.find((l) => l.id === locationId);
  return { id: locationId, name: location?.name ?? locationId };
}

export function characterNameOf(db: DbOrTx, memberId: string | null): string {
  if (memberId === null) return '';
  return db.select({ name: character.name }).from(character).where(eq(character.memberId, memberId)).get()?.name ?? '';
}

/** A stored feed / narration / whisper entry as `viewer` receives it, live, on replay and in the game log (GEN-037). */
export function entryViewOf(db: DbOrTx, row: RoomEntryRow, viewer: { id: string }): RoomEntry {
  return {
    seq: row.id,
    kind: row.kind,
    day: row.day,
    phase: row.phase,
    turn: row.turn === 2 ? 2 : 1,
    place: placeViewOf(db, row.gameId, row.locationId),
    text: row.text,
    ...(row.kind === 'whisper'
      ? { whisper: { from: characterNameOf(db, row.fromMemberId), to: characterNameOf(db, row.toMemberId), mine: row.fromMemberId === viewer.id } }
      : {}),
    // Q-177: players learn only that it is the template, never why.
    ...(row.fallback !== null ? { fallback: true as const } : {}),
  };
}
