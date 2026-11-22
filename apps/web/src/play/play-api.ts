import { ApiError, CompanionsResponse, InventoryResponse, SurroundingsResponse, TravelResponse, type CharacterView, type CompanionView, type InventoryView, type NpcView, type OtherCharacterView } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { apiUrl, fetchWithTimeout } from '../session.ts';

/**
 * The HTTP side of the Play screen (GEN-088): what the socket does not carry. Every answer is parsed with its
 * contract schema (GEN-099); anything else counts as "could not load", never as data.
 */
export type Loaded<T> = { kind: 'ok'; data: T } | { kind: 'session_lost' } | { kind: 'error' };

/** The part of a zod schema this file uses (the web has no zod dependency of its own). */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function getJson<T>(baseUrl: string, token: string, path: string, schema: Schema<T>): Promise<Loaded<T>> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, path), { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return { kind: 'session_lost' };
    if (!res.ok) return { kind: 'error' };
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

/** Save (POST) / release (DELETE) a companion (GEN-054). The answer is the whole list; a refusal carries the server's own words. */
export async function changeCompanion(baseUrl: string, token: string, action: { save: string } | { release: string }): Promise<{ ok: true } | { ok: false; message: string; sessionLost: boolean }> {
  const save = 'save' in action;
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, save ? '/api/game/companions' : `/api/game/companions/${encodeURIComponent(action.release)}`), {
      method: save ? 'POST' : 'DELETE',
      headers: { authorization: `Bearer ${token}`, ...(save ? { 'content-type': 'application/json' } : {}) },
      ...(save ? { body: JSON.stringify({ ref: action.save }) } : {}),
    });
    if (res.ok) return { ok: true };
    const body = ApiError.safeParse(await res.json().catch(() => null));
    return { ok: false, sessionLost: res.status === 401, message: body.success ? body.data.message : 'ทำไม่สำเร็จ ลองใหม่อีกครั้ง' };
  } catch {
    return { ok: false, sessionLost: false, message: 'ต่อ server ไม่ได้ ลองใหม่อีกครั้ง' };
  }
}

export const fetchTravel =(baseUrl: string, token: string) => getJson(baseUrl, token, '/api/game/travel', TravelResponse);

/** `undefined` = not loaded yet, `null` = could not load. */
export interface PlayData {
  character: CharacterView | null | undefined;
  people: OtherCharacterView[];
  npcs: NpcView[];
  /** People + NPCs at your place; null until the surroundings are loaded. */
  seenBy: number | null;
  companions: CompanionView[] | null | undefined;
  inventory: InventoryView | null | undefined;
}

const EMPTY: PlayData = { character: undefined, people: [], npcs: [], seenBy: null, companions: undefined, inventory: undefined };

/**
 * Your character, who is at your place, your companions and your skills / items. Loaded when the screen opens
 * and again whenever `refreshKey` changes (a new turn, a move, a hit); what is on screen stays until the new
 * answer is in, so the columns do not blink.
 */
export function usePlayData(baseUrl: string, token: string, refreshKey: string | null, onSessionLost: () => void): PlayData {
  const [data, setData] = useState<PlayData>(EMPTY);
  useEffect(() => {
    if (refreshKey === null) return;
    let live = true;
    void Promise.all([
      getJson(baseUrl, token, '/api/game/surroundings', SurroundingsResponse),
      getJson(baseUrl, token, '/api/game/companions', CompanionsResponse),
      getJson(baseUrl, token, '/api/game/inventory', InventoryResponse),
    ]).then(([surroundings, companions, inventory]) => {
      if (!live) return;
      if ([surroundings, companions, inventory].some((r) => r.kind === 'session_lost')) return onSessionLost();
      const around = surroundings.kind === 'ok' && surroundings.data.view === 'player' ? surroundings.data : null;
      setData({
        character: around ? around.you : null,
        people: around?.people ?? [],
        npcs: around?.npcs ?? [],
        seenBy: around ? around.people.length + around.npcs.length : null,
        companions: companions.kind === 'ok' ? companions.data.companions : null,
        inventory: inventory.kind === 'ok' ? inventory.data.inventory : null,
      });
    });
    return () => {
      live = false;
    };
    // onSessionLost is the page's own callback, stable for the life of the room.
  }, [baseUrl, token, refreshKey]);
  return data;
}
