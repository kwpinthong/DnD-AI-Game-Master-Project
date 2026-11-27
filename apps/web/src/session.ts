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

/**
 * Every session token this browser got (GEN-037): one per game joined or created, so the game list can
 * open old games read-only. A session is per game (GEN-024), so this list is the browser's "my games".
 */
export const KNOWN_TOKENS_KEY = 'isekai.knownSessions';

/** ISK-022: one row of เกมของฉัน. Never the PIN. A pre-ISK-022 entry (a bare token string) reads as `{ token }`. */
export interface KnownSession {
  token: string;
  gameId?: string;
  gameName?: string;
  /** Normalised (no dash), as GameView sends it. */
  inviteCode?: string;
  playerName?: string;
  /** ISO time of the last join / entry. */
  lastSeen?: string;
}

const FIELDS = ['gameId', 'gameName', 'inviteCode', 'playerName', 'lastSeen'] as const;

/** One stored entry as a row: only string fields are kept (whatever else is there, a PIN never is). */
function sessionOf(entry: unknown): KnownSession | null {
  if (typeof entry === 'string') return entry ? { token: entry } : null;
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.token !== 'string' || !e.token) return null;
  const row: KnownSession = { token: e.token };
  for (const f of FIELDS) if (typeof e[f] === 'string') row[f] = e[f];
  return row;
}

/** Newest first; a broken value reads as none; null = this browser's storage cannot be used. */
export function loadKnownSessions(): KnownSession[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KNOWN_TOKENS_KEY);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.map(sessionOf).filter((s) => s !== null) : [];
  } catch {
    return [];
  }
}

function saveKnownSessions(rows: KnownSession[]) {
  try {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(rows));
  } catch {
    // ignore: see loadToken
  }
}

/** A join or an entry: the row of the same token or game is replaced (fields merged, new token) and moved to the top. */
export function rememberSession(session: KnownSession): void {
  const rows = loadKnownSessions() ?? [];
  const same = (r: KnownSession) => r.token === session.token || (session.gameId !== undefined && r.gameId === session.gameId);
  // oldest first, so a newer row's fields win over an older one's
  const merged = Object.assign({}, ...rows.filter(same).reverse(), session, { lastSeen: new Date().toISOString() }) as KnownSession;
  saveKnownSessions([merged, ...rows.filter((r) => !same(r))]);
}

export function forgetSession(token: string): void {
  saveKnownSessions((loadKnownSessions() ?? []).filter((r) => r.token !== token));
}

/** The tokens of the rows, newest first (the GEN-037 game list). */
export const loadKnownTokens = (): string[] => (loadKnownSessions() ?? []).map((r) => r.token);

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
  // playerCode + noStyle: `JoinStyleFields` (GEN-082), sent beside the `JoinRequest` fields.
  body: { inviteCode: string; name: string; pin: string; playerCode?: string; noStyle?: boolean },
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
