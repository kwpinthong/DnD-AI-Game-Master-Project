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
} from '@isekai/protocol';

/** The old PATCH /api/game body: the server removed the route in ISK-017 (404); ISK-019 removes the lobby edits. */
type UpdateGameRequest = { gameName?: string; mode?: 'online' | 'single'; npcDialogue?: NpcDialogueLevel; tone?: GameTone; memory?: GameMemorySetting };
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
}

export type CreateGameResult =
  | { ok: true; member: Member; token: string; game: GameView }
  | { ok: false; fields: Partial<Record<CreateGameField, string>>; form?: string };

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
    case 'invalid_input':
      return { ok: false, fields: error.data.fields };
    case 'wrong_create_code':
      return { ok: false, fields: { createCode: error.data.message } };
    default:
      return { ok: false, fields: {}, form: error.data.message };
  }
}

/** A lobby call's result: the game, the session is gone (kicked / expired), or a Thai error to show. */
export type GameResult =
  | { kind: 'ok'; game: GameView }
  | { kind: 'session_lost' }
  | { kind: 'error'; message: string; reasons?: string[] };

export type GameAction =
  | { method: 'GET'; path: '/api/game' }
  | { method: 'POST'; path: '/api/game/invite-code' | '/api/game/start' }
  | { method: 'DELETE'; path: `/api/game/members/${string}` }
  /** GEN-127: the owner edits the game before the start (npcDialogue). */
  | { method: 'PATCH'; path: '/api/game'; body: UpdateGameRequest };

export async function gameCall(baseUrl: string, token: string, action: GameAction): Promise<GameResult> {
  const patch = action.method === 'PATCH';
  const answer = await send(apiUrl(baseUrl, action.path), {
    method: action.method,
    headers: { authorization: `Bearer ${token}`, ...(patch ? { 'content-type': 'application/json' } : {}) },
    ...(patch ? { body: JSON.stringify(action.body) } : {}),
  });
  if (!answer) return { kind: 'error', message: UNREACHABLE };
  if (answer.res.ok) {
    const parsed = GameView.safeParse(answer.json);
    return parsed.success ? { kind: 'ok', game: parsed.data } : { kind: 'error', message: UNREACHABLE };
  }
  if (answer.res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(answer.json);
  if (!error.success) return { kind: 'error', message: UNREACHABLE };
  if (error.data.code === 'cannot_start') return { kind: 'error', message: error.data.message, reasons: error.data.reasons };
  return { kind: 'error', message: error.data.message };
}

/** DELETE /api/game (GEN-112): the owner deletes the game for everyone; `confirmName` is the typed game name. */
export async function deleteGameCall(baseUrl: string, token: string, confirmName: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // 204 has no body, so this does not go through `send` (which reads JSON).
    const res = await fetchWithTimeout(apiUrl(baseUrl, '/api/game'), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName }),
    });
    if (res.ok) return { ok: true };
    const error = ApiError.safeParse(await res.json());
    return { ok: false, message: error.success ? error.data.message : UNREACHABLE };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

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
