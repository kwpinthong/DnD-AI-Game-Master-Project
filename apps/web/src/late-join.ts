import { ApiError, GameTimelineResponse } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

/**
 * ISK-016: a player who joined a started game prepares (character, loot, spawn) before Play. This browser keeps,
 * per session token, the day they joined on (the banner shows it, never today's) and the step they were at, so a
 * refresh opens the same step. The mark goes once they spawned; a lost session that still has it = the seat was
 * given back (ISK-015: not spawned a whole period after the one they joined in).
 */
export type LateJoinStep = 'character' | 'spawn';
export interface LateJoinMark {
  /** The game day when they joined; null when the server could not be asked then. */
  day: number | null;
  step: LateJoinStep;
}

const key = (token: string) => `isekai.lateJoin.${token}`;

// Storage can throw (private mode, blocked site data): then nothing is kept and the setup starts from the server's state.
export function loadLateJoin(token: string): LateJoinMark | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(token)) ?? 'null') as LateJoinMark | null;
    return parsed && (parsed.step === 'character' || parsed.step === 'spawn') ? { day: typeof parsed.day === 'number' ? parsed.day : null, step: parsed.step } : null;
  } catch {
    return null;
  }
}

export function saveLateJoin(token: string, mark: LateJoinMark): void {
  try {
    localStorage.setItem(key(token), JSON.stringify(mark));
  } catch {
    // ignore: see loadLateJoin
  }
}

/** Removes the mark; true when there was one. */
export function takeLateJoin(token: string): boolean {
  const had = loadLateJoin(token) !== null;
  try {
    localStorage.removeItem(key(token));
  } catch {
    // ignore: see loadLateJoin
  }
  return had;
}

/** Today's game day from GET /api/game/timeline; null when it cannot be told. */
export async function currentDay(baseUrl: string, token: string): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, '/api/game/timeline'), { headers: { authorization: `Bearer ${token}` } });
    const parsed = GameTimelineResponse.safeParse(await res.json());
    return res.ok && parsed.success ? (parsed.data.at?.day ?? null) : null;
  } catch {
    return null;
  }
}

export type SpawnResult = { kind: 'ok' } | { kind: 'session_lost' } | { kind: 'error'; message: string };

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

/** POST /api/game/spawn (ISK-015): the spawn point is rolled; the crossing story is read with GET /api/game/origin. */
export async function spawnCall(baseUrl: string, token: string): Promise<SpawnResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, '/api/game/spawn'), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 401) return { kind: 'session_lost' };
    const error = ApiError.safeParse(await res.json());
    return { kind: 'error', message: error.success ? error.data.message : UNREACHABLE };
  } catch {
    return { kind: 'error', message: UNREACHABLE };
  }
}
