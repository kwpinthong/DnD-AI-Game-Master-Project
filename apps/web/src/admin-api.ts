import {
  AdminCorrectionResponse,
  AdminCorrectionsExportResponse,
  AdminDownvotesResponse,
  type AdminCorrectionRequest,
  AdminSessionResponse,
  AiUsageGameResponse,
  AiUsageOverviewResponse,
  ApiError,
  GameDataAuditResponse,
  GameDataExportResponse,
  GameDataListResponse,
  GameDataSetResponse,
  LearningLibraryResponse,
} from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

export type AdminResult<T> =
  | { kind: 'ok'; data: T }
  /** 403: not (or no longer) the server owner's admin token. */
  | { kind: 'forbidden'; message: string }
  /** `fields`: 400 invalid_input's field → problem (GEN-147 game data schema misses). */
  | { kind: 'error'; message: string; fields?: Record<string, string> };

async function call<T>(baseUrl: string, path: string, init: RequestInit, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<AdminResult<T>> {
  let res: Response;
  let json: unknown;
  try {
    res = await fetchWithTimeout(apiUrl(baseUrl, path), init);
    json = await res.json();
  } catch {
    return { kind: 'error', message: UNREACHABLE };
  }
  if (res.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', message: UNREACHABLE };
  }
  const error = ApiError.safeParse(json);
  const message = error.success ? error.data.message : UNREACHABLE;
  if (res.status === 403 && error.success && error.data.code === 'forbidden') return { kind: 'forbidden', message };
  return error.success && error.data.code === 'invalid_input' ? { kind: 'error', message, fields: error.data.fields } : { kind: 'error', message };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** GEN-147: the game data editor (server owner only). */
export function fetchGameDataList(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/game-data', { headers: auth(token) }, GameDataListResponse);
}

export function fetchGameDataSet(baseUrl: string, token: string, name: string) {
  return call(baseUrl, `/api/admin/game-data/${encodeURIComponent(name)}`, { headers: auth(token) }, GameDataSetResponse);
}

export function saveGameDataSet(baseUrl: string, token: string, name: string, value: unknown) {
  return call(
    baseUrl,
    `/api/admin/game-data/${encodeURIComponent(name)}`,
    { method: 'PUT', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ value }) },
    GameDataSetResponse,
  );
}

export function undoGameDataSet(baseUrl: string, token: string, name: string) {
  return call(baseUrl, `/api/admin/game-data/${encodeURIComponent(name)}/undo`, { method: 'POST', headers: auth(token) }, GameDataSetResponse);
}

export function fetchGameDataAudit(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/game-data-audit', { headers: auth(token) }, GameDataAuditResponse);
}

export function fetchGameDataExport(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/game-data-export', { headers: auth(token) }, GameDataExportResponse);
}

/** Exchanges the admin code for a short-lived admin token (the code is not kept anywhere). */
export function postAdminSession(baseUrl: string, code: string) {
  return call(baseUrl, '/api/admin/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }, AdminSessionResponse);
}

export function fetchUsageOverview(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/ai-usage', { headers: { authorization: `Bearer ${token}` } }, AiUsageOverviewResponse);
}

export function fetchGameUsage(baseUrl: string, token: string, gameId: string) {
  return call(baseUrl, `/api/admin/ai-usage/${encodeURIComponent(gameId)}`, { headers: { authorization: `Bearer ${token}` } }, AiUsageGameResponse);
}

/** GEN-084 contract: the Learning library, the server owner only (Q-168). Every answer is the whole library. */
export function fetchLearningLibrary(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/learning', { headers: { authorization: `Bearer ${token}` } }, LearningLibraryResponse);
}

export function deleteLearningEntry(baseUrl: string, token: string, id: string) {
  return call(baseUrl, `/api/admin/learning/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }, LearningLibraryResponse);
}

export function deleteLearningGame(baseUrl: string, token: string, gameId: string) {
  return call(baseUrl, `/api/admin/learning/games/${encodeURIComponent(gameId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }, LearningLibraryResponse);
}

/** GEN-168: the 👎 review (server owner only). */
export function fetchDownvotes(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/downvotes', { headers: auth(token) }, AdminDownvotesResponse);
}

export function postCorrection(baseUrl: string, token: string, body: AdminCorrectionRequest) {
  return call(baseUrl, '/api/admin/corrections', { method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(body) }, AdminCorrectionResponse);
}

export function fetchCorrectionsExport(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/corrections-export', { headers: auth(token) }, AdminCorrectionsExportResponse);
}

export async function postAdminLogout(baseUrl: string, token: string): Promise<void> {
  try {
    await fetch(apiUrl(baseUrl, '/api/admin/logout'), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  } catch {
    // offline: the token expires on its own within the hour
  }
}
