import { ApiError, GameLogResponse, GameRatingResponse, type GameRatingRequest, type GameRatingView } from '@isekai/protocol';
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

export type RatingResult = { ok: true; rating: GameRatingView } | { ok: false; message: string };

const RATING_UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

/** One call of the GEN-078 rating endpoints: the new view, or the server's Thai error message. */
async function ratingCall(baseUrl: string, token: string, method: 'GET' | 'PUT' | 'DELETE', path: string, body?: GameRatingRequest): Promise<RatingResult> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, path), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json: unknown = await res.json();
    if (res.ok) {
      const parsed = GameRatingResponse.safeParse(json);
      return parsed.success ? { ok: true, rating: parsed.data.rating } : { ok: false, message: RATING_UNREACHABLE };
    }
    const error = ApiError.safeParse(json);
    return { ok: false, message: error.success ? error.data.message : RATING_UNREACHABLE };
  } catch {
    return { ok: false, message: RATING_UNREACHABLE };
  }
}

export const fetchRating = (baseUrl: string, token: string) => ratingCall(baseUrl, token, 'GET', '/api/game/rating');
export const sendRating = (baseUrl: string, token: string, rating: GameRatingRequest) => ratingCall(baseUrl, token, 'PUT', '/api/game/rating', rating);
/** 👍 on (`PUT`) or off (`DELETE`) for one action → result row. */
export const setRulingLike = (baseUrl: string, token: string, sourceRef: string, on: boolean) =>
  ratingCall(baseUrl, token, on ? 'PUT' : 'DELETE', `/api/game/rating/likes/${encodeURIComponent(sourceRef)}`);
