import {
  ApiError,
  GM_CONSOLE_PATH,
  GmAdjustResponse,
  GmApproveResponse,
  GmConsoleResponse,
  GmInsertEventResponse,
  GmLogResponse,
  GmPendingTurn,
  GmSettings,
  GmVotesResponse,
  type GmAdjustRequest,
  type GmInsertEventRequest,
  type GmTurnEditRequest,
} from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

/** The Human GM console's calls (GEN-058). Errors come back as the server's Thai message. */
export type GmCallResult<T> = { ok: true; value: T } | { ok: false; message: string };

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function gmCall<T>(baseUrl: string, token: string, method: 'GET' | 'POST' | 'PUT', path: string, schema: Schema<T>, body?: unknown): Promise<GmCallResult<T>> {
  let json: unknown;
  let res: Response;
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    res = await fetchWithTimeout(apiUrl(baseUrl, `${GM_CONSOLE_PATH}${path}`), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    json = await res.json();
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (res.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: UNREACHABLE };
  }
  const error = ApiError.safeParse(json);
  if (!error.success) return { ok: false, message: UNREACHABLE };
  if (error.data.code === 'invalid_input') return { ok: false, message: Object.values(error.data.fields)[0] ?? error.data.message };
  return { ok: false, message: error.data.message };
}

export const gmConsoleApi = (baseUrl: string, token: string) => ({
  view: () => gmCall(baseUrl, token, 'GET', '/console', GmConsoleResponse),
  log: () => gmCall(baseUrl, token, 'GET', '/log', GmLogResponse),
  votes: () => gmCall(baseUrl, token, 'GET', '/votes', GmVotesResponse),
  editTurn: (body: GmTurnEditRequest) => gmCall(baseUrl, token, 'POST', '/turn/edit', GmPendingTurn, body),
  approve: () => gmCall(baseUrl, token, 'POST', '/turn/approve', GmApproveResponse),
  adjust: (body: GmAdjustRequest) => gmCall(baseUrl, token, 'POST', '/adjust', GmAdjustResponse, body),
  insertEvent: (body: GmInsertEventRequest) => gmCall(baseUrl, token, 'POST', '/events', GmInsertEventResponse, body),
  saveSettings: (body: GmSettings) => gmCall(baseUrl, token, 'PUT', '/settings', GmSettings, body),
});
