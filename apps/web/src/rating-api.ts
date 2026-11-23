import { ApiError, GameLearningResponse, GameRatingResponse, type EntryVote, type GameRatingRequest, type GameRatingView, type ResponseVoteRequest } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

/**
 * The end page's rating calls (GEN-099 contract; the backend is GEN-078 / 079 / 081): the game score 1–10 with
 * a comment, and the 👍/👎 on an action → result row by its `sourceRef`. Every answer is the whole rating view.
 */
export type RatingResult = { ok: true; rating: GameRatingView } | { ok: false; message: string };

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

async function call(baseUrl: string, token: string, method: 'GET' | 'PUT', path: string, body?: GameRatingRequest | ResponseVoteRequest): Promise<RatingResult> {
  let res: Response;
  let json: unknown;
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    res = await fetchWithTimeout(apiUrl(baseUrl, `/api/game/rating${path}`), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    json = await res.json();
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (res.ok) {
    const parsed = GameRatingResponse.safeParse(json);
    return parsed.success ? { ok: true, rating: parsed.data.rating } : { ok: false, message: UNREACHABLE };
  }
  const error = ApiError.safeParse(json);
  if (!error.success) return { ok: false, message: UNREACHABLE };
  if (error.data.code === 'invalid_input') return { ok: false, message: Object.values(error.data.fields)[0] ?? error.data.message };
  return { ok: false, message: error.data.message };
}

/** Q-363: the game owner's learning extract status (GET) or retry (POST); null = not the owner / not ended / unreachable. */
export async function learningStatus(baseUrl: string, token: string, method: 'GET' | 'POST'): Promise<GameLearningResponse['status'] | null> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, method === 'GET' ? '/api/game/learning' : '/api/game/learning/extract'), { method, headers: { authorization: `Bearer ${token}` } });
    const parsed = GameLearningResponse.safeParse(await res.json());
    return res.ok && parsed.success ? parsed.data.status : null;
  } catch {
    return null;
  }
}

export const ratingApi = (baseUrl: string, token: string) => ({
  get: () => call(baseUrl, token, 'GET', ''),
  put: (body: GameRatingRequest) => call(baseUrl, token, 'PUT', '', body),
  /** GEN-171: 👍/👎 on a ruling; null cancels. */
  vote: (sourceRef: string, vote: EntryVote | null) => call(baseUrl, token, 'PUT', `/votes/${encodeURIComponent(sourceRef)}`, { vote }),
});
