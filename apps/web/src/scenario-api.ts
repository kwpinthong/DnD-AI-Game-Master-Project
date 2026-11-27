import { ApiError, GameScenarioResponse } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

/** GET /api/game/scenario: the Human GM's read-only copy (ISK-017: set at creation, no save / reset any more). */
export type ScenarioResult = { kind: 'ok'; data: GameScenarioResponse } | { kind: 'session_lost' } | { kind: 'error'; message: string };

export async function scenarioCall(baseUrl: string, token: string): Promise<ScenarioResult> {
  let res: Response;
  let json: unknown;
  try {
    res = await fetchWithTimeout(apiUrl(baseUrl, '/api/game/scenario'), { method: 'GET', headers: { authorization: `Bearer ${token}` } });
    json = await res.json();
  } catch {
    return { kind: 'error', message: UNREACHABLE };
  }
  if (res.ok) {
    const parsed = GameScenarioResponse.safeParse(json);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', message: UNREACHABLE };
  }
  if (res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(json);
  return { kind: 'error', message: error.success ? error.data.message : UNREACHABLE };
}
