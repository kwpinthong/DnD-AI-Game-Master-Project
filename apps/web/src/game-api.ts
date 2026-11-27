import {
  ApiError,
  CharacterResponse,
  CreateGameResponse,
  GameView,
  InventoryResponse,
  LootResponse,
  MemorySourcesResponse,
  type MemorySourcesRequest,
  OriginResponse,
  PlayerStyleResponse,
  type PlayerStyleRequest,
  type GameMemorySetting,
  type InventoryView,
  type MemorySourceGame,
  type OriginView,
  type LootChooseRequest,
  type LootView,
  type CharacterField,
  type CharacterRequest,
  type CharacterView,
  type CreateGameField,
  type Member,
  type NpcDialogueLevel,
  type GameTone,
  type Scenario,
  CreateGameRequest,
} from '@isekai/protocol';
import { fetchGameLog } from './history-api.ts';
import { apiUrl, fetchWithTimeout } from './session.ts';

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

export interface CreateGameInput {
  createCode: string;
  gameName: string;
  mode: 'online' | 'single';
  humanGm: boolean;
  npcDialogue?: NpcDialogueLevel;
  /** GEN-177: absent = the server default tone. */
  tone?: GameTone;
  name: string;
  pin: string;
  /** GEN-082 / GEN-083: the creator's player code and the memory toggle (absent = off). */
  playerCode?: string;
  /** GEN-201: the creator's opt-out tick (absent = keep). */
  noStyle?: boolean;
  memory?: GameMemorySetting;
  /** ISK-017 / ISK-019: the Human GM's edited scenario, set once here (absent = the default). */
  scenario?: Scenario;
}

/** `scenarioFields`: the refused scenario's messages by its own paths (`timeline.0.title`), for the scenario step. */
export type CreateGameResult =
  | { ok: true; member: Member; token: string; game: GameView }
  | { ok: false; fields: Partial<Record<CreateGameField, string>>; form?: string; scenarioFields?: Record<string, string> };

const FORM_FIELDS = new Set<string>(Object.keys(CreateGameRequest.shape).filter((k) => k !== 'scenario'));

async function send(url: string, init: RequestInit): Promise<{ res: Response; json: unknown } | undefined> {
  try {
    const res = await fetchWithTimeout(url, init);
    return { res, json: await res.json() };
  } catch {
    return undefined;
  }
}

export async function postCreateGame(baseUrl: string, body: CreateGameInput): Promise<CreateGameResult> {
  const answer = await send(apiUrl(baseUrl, '/api/games'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!answer) return { ok: false, fields: {}, form: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = CreateGameResponse.safeParse(answer.json);
    if (parsed.success) return { ok: true, member: parsed.data.member, token: parsed.data.token, game: parsed.data.game };
    return { ok: false, fields: {}, form: UNREACHABLE };
  }
  const error = ApiError.safeParse(answer.json);
  if (!error.success) return { ok: false, fields: {}, form: UNREACHABLE };
  switch (error.data.code) {
    case 'invalid_input': {
      const fields: Record<string, string> = {};
      const scenarioFields: Record<string, string> = {};
      for (const [path, message] of Object.entries(error.data.fields)) (FORM_FIELDS.has(path) ? fields : scenarioFields)[path] = message;
      return { ok: false, fields, ...(Object.keys(scenarioFields).length > 0 ? { scenarioFields } : {}) };
    }
    case 'wrong_create_code':
      return { ok: false, fields: { createCode: error.data.message } };
    default:
      return { ok: false, fields: {}, form: error.data.message };
  }
}

/**
 * A lobby call's result: the game, the session is gone (kicked / expired), the AI GM not ready so the game did not
 * start (ISK-017 503, `blocked`), or a Thai error to show.
 */
export type GameResult =
  | { kind: 'ok'; game: GameView }
  | { kind: 'session_lost' }
  | { kind: 'blocked'; message: string }
  | { kind: 'error'; message: string };

async function lobbyCall(baseUrl: string, token: string, path: string, init: RequestInit): Promise<GameResult> {
  const answer = await send(apiUrl(baseUrl, path), { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = GameView.safeParse(answer.json);
    return parsed.success ? { kind: 'ok', game: parsed.data } : { kind: 'error', message: UNREACHABLE };
  }
  if (answer.res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(answer.json);
  if (!error.success) return { kind: 'error', message: UNREACHABLE };
  if (error.data.code === 'ai_not_ready') return { kind: 'blocked', message: error.data.message };
  return { kind: 'error', message: error.data.message };
}

/** GET /api/game: the lobby as the caller sees it. */
export const getGame = (baseUrl: string, token: string) => lobbyCall(baseUrl, token, '/api/game', { method: 'GET' });

/** ISK-022: where the game of one เกมของฉัน row is, asked with that row's own token. */
export type MyGameState =
  | { kind: 'lobby' | 'setup' | 'ended' | 'closed'; game: GameView }
  | { kind: 'playing'; game: GameView; day: number }
  | { kind: 'expired' | 'kicked' | 'gone' | 'offline' };

export async function myGameState(baseUrl: string, token: string): Promise<MyGameState> {
  const answer = await send(apiUrl(baseUrl, '/api/game'), { headers: { authorization: `Bearer ${token}` } });
  if (!answer) return { kind: 'offline' };
  // 401 = session_expired or any other refused token: the join form asks for the PIN (ISK-021).
  if (answer.res.status === 401) return { kind: 'expired' };
  if (answer.res.status === 403) return { kind: 'kicked' };
  if (answer.res.status === 404) return { kind: 'gone' };
  const parsed = GameView.safeParse(answer.json);
  if (!answer.res.ok || !parsed.success) return { kind: 'offline' };
  const game = parsed.data;
  if (game.closed) return { kind: 'closed', game };
  if (game.status === 'lobby') return { kind: 'lobby', game };
  // A started game whose player has no character yet: the character step (the lobby's own rule for [เข้าห้องเล่น]).
  if (game.you.role === 'player' && !game.members.find((m) => m.id === game.you.memberId)?.hasCharacter) return { kind: 'setup', game };
  // shortcut: the day and the end come from GET /api/game/log (GameView has neither); one request less once GameView carries them.
  const log = await fetchGameLog(baseUrl, token);
  if (log === null) return { kind: 'expired' };
  if (log === 'unreachable') return { kind: 'offline' };
  return log.game.status === 'ended' ? { kind: 'ended', game } : { kind: 'playing', game, day: log.game.at?.day ?? 1 };
}

/** POST /api/game/ready (ISK-017): press / release ready; the server starts the game itself once everyone is ready. */
export const readyCall = (baseUrl: string, token: string, ready: boolean) =>
  lobbyCall(baseUrl, token, '/api/game/ready', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ready }) });

/** A character call's result (GEN-047): the character (null = none yet), field errors, or a Thai error. */
export type CharacterResult =
  | { kind: 'ok'; character: CharacterView | null }
  | { kind: 'session_lost' }
  | { kind: 'invalid'; fields: Partial<Record<CharacterField, string>> }
  | { kind: 'error'; message: string };

/** A loot call's result (GEN-048): the step's state, or a Thai error (first field error when refused). */
export type LootResult = { kind: 'ok'; loot: LootView } | { kind: 'session_lost' } | { kind: 'error'; message: string };

export type LootAction = { kind: 'get' } | { kind: 'roll' } | { kind: 'choose'; body: LootChooseRequest };

export async function lootCall(baseUrl: string, token: string, action: LootAction): Promise<LootResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (action.kind === 'choose') headers['content-type'] = 'application/json';
  const path = action.kind === 'choose' ? '/api/game/character/loot/choose' : '/api/game/character/loot';
  const answer = await send(apiUrl(baseUrl, path), {
    method: action.kind === 'get' ? 'GET' : 'POST',
    headers,
    ...(action.kind === 'choose' ? { body: JSON.stringify(action.body) } : {}),
  });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = LootResponse.safeParse(answer.json);
    return parsed.success ? { kind: 'ok', loot: parsed.data.loot } : { kind: 'error', message: UNREACHABLE };
  }
  if (answer.res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(answer.json);
  if (!error.success) return { kind: 'error', message: UNREACHABLE };
  if (error.data.code === 'invalid_input') {
    return { kind: 'error', message: Object.values(error.data.fields).join(' / ') || error.data.message };
  }
  return { kind: 'error', message: error.data.message };
}

/** GET /api/game/inventory (GEN-055): your own skills, the items you hold now and your library discoveries. */
export type InventoryResult = { kind: 'ok'; inventory: InventoryView } | { kind: 'session_lost' } | { kind: 'error'; message: string };

export async function inventoryCall(baseUrl: string, token: string): Promise<InventoryResult> {
  const answer = await send(apiUrl(baseUrl, '/api/game/inventory'), { method: 'GET', headers: { authorization: `Bearer ${token}` } });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = InventoryResponse.safeParse(answer.json);
    return parsed.success ? { kind: 'ok', inventory: parsed.data.inventory } : { kind: 'error', message: UNREACHABLE };
  }
  if (answer.res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(answer.json);
  return { kind: 'error', message: error.success ? error.data.message : UNREACHABLE };
}

/** GET /api/game/origin (GEN-065): your own start scenario; null before the start and for the Human GM. */
export type OriginResult = { kind: 'ok'; origin: OriginView | null } | { kind: 'session_lost' } | { kind: 'error'; message: string };

export async function originCall(baseUrl: string, token: string): Promise<OriginResult> {
  const answer = await send(apiUrl(baseUrl, '/api/game/origin'), { method: 'GET', headers: { authorization: `Bearer ${token}` } });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = OriginResponse.safeParse(answer.json);
    if (!parsed.success) return { kind: 'error', message: UNREACHABLE };
    return { kind: 'ok', origin: parsed.data.view === 'player' ? parsed.data.origin : null };
  }
  if (answer.res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(answer.json);
  return { kind: 'error', message: error.success ? error.data.message : UNREACHABLE };
}

/**
 * POST /api/memory/sources (GEN-083): the ended games the creator was in, found by the creator's player code (Q-225). The code goes in the POST body only, never in a URL
 * or a header (Q-276).
 */
export type MemorySourcesResult = { kind: 'ok'; games: MemorySourceGame[] } | { kind: 'error'; message: string };

export async function memorySourcesCall(baseUrl: string, playerCode: string): Promise<MemorySourcesResult> {
  const body: MemorySourcesRequest = { playerCode };
  const answer = await send(apiUrl(baseUrl, '/api/memory/sources'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = MemorySourcesResponse.safeParse(answer.json);
    return parsed.success ? { kind: 'ok', games: parsed.data.games } : { kind: 'error', message: UNREACHABLE };
  }
  const error = ApiError.safeParse(answer.json);
  return { kind: 'error', message: error.success ? error.data.message : UNREACHABLE };
}

/**
 * GEN-200: "สไตล์ของฉัน" on the GEN-082 routes: look up, delete, or switch keeping off (`optOut`). The code goes in
 * the body only. A 403 says nothing about whether the code exists: the server's "not found" wording stays out.
 */
export type PlayerStyleResult = { kind: 'ok'; data: PlayerStyleResponse } | { kind: 'error'; message: string };
export const WRONG_PLAYER_CODE = 'ใช้รหัสนี้ไม่ได้ ตรวจรหัสแล้วลองใหม่';

export async function playerStyleCall(baseUrl: string, action: 'view' | 'delete' | { optOut: boolean }, playerCode: string): Promise<PlayerStyleResult> {
  const body: PlayerStyleRequest = typeof action === 'object' ? { playerCode, optOut: action.optOut } : { playerCode };
  const path = action === 'view' ? '/api/style' : action === 'delete' ? '/api/style/delete' : '/api/style/opt-out';
  const answer = await send(apiUrl(baseUrl, path), {
    method: typeof action === 'object' ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = PlayerStyleResponse.safeParse(answer.json);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', message: UNREACHABLE };
  }
  if (answer.res.status === 403) return { kind: 'error', message: WRONG_PLAYER_CODE };
  const error = ApiError.safeParse(answer.json);
  if (error.success && error.data.code === 'invalid_input') return { kind: 'error', message: Object.values(error.data.fields).join(' / ') || error.data.message };
  return { kind: 'error', message: error.success ? error.data.message : UNREACHABLE };
}

export async function characterCall(
  baseUrl: string,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  body?: CharacterRequest,
): Promise<CharacterResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body) headers['content-type'] = 'application/json';
  const answer = await send(apiUrl(baseUrl, '/api/game/character'), {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = CharacterResponse.safeParse(answer.json);
    return parsed.success ? { kind: 'ok', character: parsed.data.character } : { kind: 'error', message: UNREACHABLE };
  }
  if (answer.res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(answer.json);
  if (!error.success) return { kind: 'error', message: UNREACHABLE };
  if (error.data.code === 'invalid_input') return { kind: 'invalid', fields: error.data.fields };
  return { kind: 'error', message: error.data.message };
}
