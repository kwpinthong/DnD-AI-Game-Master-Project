import { GameLogResponse } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

/** GET /api/game/log for one kept token (GEN-037): the log, null when the server refused the session, 'unreachable' otherwise. */
export async function fetchGameLog(baseUrl: string, token: string): Promise<GameLogResponse | null | 'unreachable'> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, '/api/game/log'), { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return null;
    const parsed = GameLogResponse.safeParse(await res.json());
    return res.ok && parsed.success ? parsed.data : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
// The rating calls (score, 👍) live in rating-api.ts (GEN-091), the one client of the GEN-078 endpoints.
