import { ApiError, GameScenarioResponse, type Scenario } from '@isekai/protocol';
import { apiUrl, fetchWithTimeout } from './session.ts';

const UNREACHABLE = 'ติดต่อ server ไม่ได้ ลองใหม่อีกครั้ง';

/** A scenario editor call: the GM's copy, a refused save with messages per field path, or an error. */
export type ScenarioResult =
  | { kind: 'ok'; data: GameScenarioResponse }
  | { kind: 'session_lost' }
  | { kind: 'invalid'; fields: Record<string, string> }
  | { kind: 'error'; message: string };

export type ScenarioAction = { kind: 'load' } | { kind: 'save'; scenario: Scenario } | { kind: 'reset' };

const request = (token: string, action: ScenarioAction): [string, RequestInit] => {
  const authorization = `Bearer ${token}`;
  switch (action.kind) {
    case 'load':
      return ['/api/game/scenario', { method: 'GET', headers: { authorization } }];
    case 'save':
      return [
        '/api/game/scenario',
        { method: 'PUT', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(action.scenario) },
      ];
    case 'reset':
      return ['/api/game/scenario/reset', { method: 'POST', headers: { authorization } }];
  }
};

export async function scenarioCall(baseUrl: string, token: string, action: ScenarioAction): Promise<ScenarioResult> {
  const [path, init] = request(token, action);
  let res: Response;
  let json: unknown;
  try {
    res = await fetchWithTimeout(apiUrl(baseUrl, path), init);
    json = await res.json();
  } catch {
    return { kind: 'error', message: UNREACHABLE };
  }
  if (res.ok) {
    const parsed = GameScenarioResponse.safeParse(json);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', message: UNREACHABLE };
  }
  if (res.status === 401) return { kind: 'session_lost' };
  const error = ApiError.safeParse(json);
  if (!error.success) return { kind: 'error', message: UNREACHABLE };
  if (error.data.code === 'invalid_input') return { kind: 'invalid', fields: error.data.fields };
  return { kind: 'error', message: error.data.message };
}
