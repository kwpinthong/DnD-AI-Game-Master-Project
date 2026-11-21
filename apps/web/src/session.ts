import { ApiError, JoinResponse, MeResponse, type JoinField, type Member } from '@isekai/protocol';

/** localStorage key of the bearer token (the server keeps only its hash, with an expiry). */
export const TOKEN_KEY = 'isekai.sessionToken';

// Storage can throw (private mode, blocked site data); then the session lasts only this page.
export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null) {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore: see loadToken
  }
}

/** A server that accepts the connection but never answers counts as unreachable after this long. */
export const REQUEST_TIMEOUT_MS = 8_000;

/** fetch that gives up after REQUEST_TIMEOUT_MS (or when `signal` aborts) by rejecting like a network error. */
export function fetchWithTimeout(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  });
}

/** Joins the API base URL ('' = same origin via the Vite proxy) with a path. */
export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export type JoinResult =
  | { ok: true; member: Member; token: string }
  | { ok: false; fields: Partial<Record<JoinField, string>>; form?: string };

const UNREACHABLE = 'ติดต่อ server ไม่ได้ เกมอาจยังไม่เปิด ลองใหม่ภายหลัง';

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });

export async function postJoin(
  baseUrl: string,
  body: { inviteCode: string; name: string; pin: string },
): Promise<JoinResult> {
  let res: Response;
  let json: unknown;
  try {
    res = await fetchWithTimeout(apiUrl(baseUrl, '/api/join'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    json = await res.json();
  } catch {
    return { ok: false, fields: {}, form: UNREACHABLE };
  }

  if (res.ok) {
    const parsed = JoinResponse.safeParse(json);
    if (parsed.success) return { ok: true, member: parsed.data.member, token: parsed.data.token };
    return { ok: false, fields: {}, form: UNREACHABLE };
  }

  const error = ApiError.safeParse(json);
  if (!error.success) return { ok: false, fields: {}, form: UNREACHABLE };
  switch (error.data.code) {
    case 'invalid_input':
      return { ok: false, fields: error.data.fields };
    case 'game_not_found':
      return { ok: false, fields: { inviteCode: error.data.message } };
    case 'wrong_pin':
      return { ok: false, fields: { pin: error.data.message } };
    case 'locked':
      return {
        ok: false,
        fields: {},
        form: `ชื่อนี้ถูกล็อกชั่วคราวเพราะใส่ PIN ผิดหลายครั้ง ลองใหม่ได้เวลา ${clockTime(error.data.retryAt)}`,
      };
    default:
      // game_full, game_started, kicked and anything newer: the server's Thai message as is.
      return { ok: false, fields: {}, form: error.data.message };
  }
}

/** The member for a kept token: a Member, null when the server refused it, 'unreachable' otherwise. */
export async function fetchMe(baseUrl: string, token: string): Promise<Member | null | 'unreachable'> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, '/api/me'), { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return null;
    const parsed = MeResponse.safeParse(await res.json());
    return res.ok && parsed.success ? parsed.data.member : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** Ends the session on the server too; the token is forgotten locally either way. */
export async function postLogout(baseUrl: string, token: string): Promise<void> {
  try {
    await fetch(apiUrl(baseUrl, '/api/logout'), { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  } catch {
    // offline: the server copy expires on its own
  }
}
