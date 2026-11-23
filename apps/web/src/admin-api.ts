import {
  type AdminCloseGameRequest,
  AdminGameRow,
  AdminGamesResponse,
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
  GameDataImportPreviewResponse,
  GameDataListResponse,
  GameDataSetResponse,
  LearningLibraryResponse,
  StyleFlagsResponse,
  StyleSettingsResponse,
  type StyleSettingsRequest,
  StyleEvalResponse,
  type StyleEvalMark,
  type StyleEvalMarkRequest,
  NpcLibraryResponse,
  type NpcExampleAddRequest,
  StyleReviewResponse,
  type StyleProposalApproveRequest,
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
  // ISK-001's game routes answer a missing / expired admin token with 401.
  if (res.status === 401 && error.success && error.data.code === 'unauthorized') return { kind: 'forbidden', message };
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

/** GEN-173: the set's asset file + its diff against the DB; nothing is saved (confirm = saveGameDataSet). */
export function fetchGameDataAssetFile(baseUrl: string, token: string, name: string) {
  return call(baseUrl, `/api/admin/game-data/${encodeURIComponent(name)}/asset-file`, { headers: auth(token) }, GameDataImportPreviewResponse);
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

/** GEN-189: the 👍/👎 kept from deleted games, the same envelope as the pairs. */
export function fetchVoteSnapshotsExport(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/vote-snapshots-export', { headers: auth(token) }, AdminCorrectionsExportResponse);
}

/** GEN-169: the style checker's flag counts and settings (server owner only). */
export function fetchStyleFlags(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/style-flags', { headers: auth(token) }, StyleFlagsResponse);
}

export function fetchStyleSettings(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/style-settings', { headers: auth(token) }, StyleSettingsResponse);
}

export function saveStyleSettings(baseUrl: string, token: string, body: StyleSettingsRequest) {
  return call(baseUrl, '/api/admin/style-settings', { method: 'PUT', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(body) }, StyleSettingsResponse);
}

/** GEN-167: the style eval rounds side by side and Nok's marks (server owner only). */
export function fetchStyleEval(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/style-eval', { headers: auth(token) }, StyleEvalResponse);
}

export function saveStyleEvalMark(baseUrl: string, token: string, runId: number, sceneId: string, mark: StyleEvalMark | null) {
  const body: StyleEvalMarkRequest = { mark };
  const path = `/api/admin/style-eval/${runId}/marks/${encodeURIComponent(sceneId)}`;
  return call(baseUrl, path, { method: 'PUT', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(body) }, StyleEvalResponse);
}

/** GEN-151: the NPC example library (server owner only); every answer is the whole library. */
export function fetchNpcLibrary(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/npc-library', { headers: auth(token) }, NpcLibraryResponse);
}

export function addNpcExample(baseUrl: string, token: string, body: NpcExampleAddRequest) {
  return call(baseUrl, '/api/admin/npc-library', { method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(body) }, NpcLibraryResponse);
}

export function deleteNpcExample(baseUrl: string, token: string, id: number) {
  return call(baseUrl, `/api/admin/npc-library/${id}`, { method: 'DELETE', headers: auth(token) }, NpcLibraryResponse);
}

/** GEN-178: the style review round (server owner only); every answer is the whole tab. */
export function fetchStyleReview(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/style-review', { headers: auth(token) }, StyleReviewResponse);
}

export function runStyleReview(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/style-review/run', { method: 'POST', headers: auth(token) }, StyleReviewResponse);
}

export function decideStyleProposal(baseUrl: string, token: string, id: number, decision: 'approve' | 'reject', body?: StyleProposalApproveRequest) {
  const json = decision === 'approve' ? { headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : { headers: auth(token) };
  return call(baseUrl, `/api/admin/style-review/proposals/${id}/${decision}`, { method: 'POST', ...json }, StyleReviewResponse);
}

export function restoreVoiceVersion(baseUrl: string, token: string, version: number) {
  return call(baseUrl, `/api/admin/style-review/voice/${version}/restore`, { method: 'POST', headers: auth(token) }, StyleReviewResponse);
}

/** ISK-001/002: every game, in the server's order. */
export function fetchAdminGames(baseUrl: string, token: string) {
  return call(baseUrl, '/api/admin/games', { headers: auth(token) }, AdminGamesResponse);
}

/** ISK-001/002: closes a game early; answers the game's row after the close. */
export function closeAdminGame(baseUrl: string, token: string, id: string, body: AdminCloseGameRequest) {
  return call(baseUrl, `/api/admin/games/${encodeURIComponent(id)}/close`, { method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(body) }, AdminGameRow);
}

export async function postAdminLogout(baseUrl: string, token: string): Promise<void> {
  try {
    await fetch(apiUrl(baseUrl, '/api/admin/logout'), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  } catch {
    // offline: the token expires on its own within the hour
  }
}
