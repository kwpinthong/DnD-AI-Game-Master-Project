import { ApiError, CreateGameResponse, GameView, type CreateGameField, type Member } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

export interface CreateGameInput {
  createCode: string;
  gameName: string;
  mode: 'online' | 'single';
  humanGm: boolean;
  name: string;
  pin: string;
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
  | { method: 'DELETE'; path: `/api/game/members/${string}` };

export async function gameCall(baseUrl: string, token: string, action: GameAction): Promise<GameResult> {
  const answer = await send(apiUrl(baseUrl, action.path), {
    method: action.method,
    headers: { authorization: `Bearer ${token}` },
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
