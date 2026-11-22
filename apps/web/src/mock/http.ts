import { CONTRACT, CONTRACT_FIXTURES, CONTRACT_SCHEMAS, type HttpItem } from '@isekai/protocol/contract';
import type { MockReply, MockScenario } from './scenarios.ts';

/**
 * The mock HTTP server (GEN-100): every route of the GEN-099 contract answers with the scenario's reply or the
 * first fixture of its response schema. A body that fails the route's request schema gets 400 invalid_input
 * like the real server, so a web bug in what it sends shows in mock mode too.
 */

export interface MockRequest {
  method: string;
  path: string;
  body?: unknown;
}

const ROUTES = CONTRACT.filter((c): c is HttpItem => c.kind === 'http').map((item) => ({
  item,
  pattern: new RegExp(`^${item.path.replace(/:\w+/g, '[^/]+')}$`),
}));

export const routeKey = (item: Pick<HttpItem, 'method' | 'path'>) => `${item.method} ${item.path}`;

export const findRoute = (method: string, path: string): HttpItem | undefined =>
  ROUTES.find((r) => r.item.method === method && r.pattern.test(path))?.item;

const ok = (body: unknown): MockReply => ({ status: 200, body });

const LIBRARY = CONTRACT_FIXTURES.LearningLibraryResponse[0]!;

/** Defaults for every scenario: the game has started (so the app goes on to the play room). */
const DEFAULTS: Readonly<Record<string, MockReply>> = {
  'GET /api/game': ok(CONTRACT_FIXTURES.GameView[1]),
  'POST /api/game/start': ok(CONTRACT_FIXTURES.GameView[1]),
  // GEN-091: a delete answers with what is left, so the library visibly loses the entry / the game.
  'DELETE /api/admin/learning/:id': ok({ entries: LIBRARY.entries.slice(1), counts: { ...LIBRARY.counts, [LIBRARY.entries[0]!.type]: 0 } }),
  'DELETE /api/admin/learning/games/:gameId': ok(CONTRACT_FIXTURES.LearningLibraryResponse[1]),
  // taking a 👍 back answers with none left of yours and one less in the total (3 → 2)
  'DELETE /api/game/rating/likes/:sourceRef': ok({ rating: { ...CONTRACT_FIXTURES.GameRatingResponse[0]!.rating, liked: [], thumbs: { '2-HESPERION-1-7': 2 } } }),
};

function invalidInput(issues: readonly { path: readonly PropertyKey[]; message: string }[]): MockReply {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form';
    fields[key] ??= issue.message;
  }
  return { status: 400, body: { code: 'invalid_input', message: 'กรอกข้อมูลไม่ถูกต้อง', fields } };
}

/**
 * `elapsedMs` = scripted time since the first request to this mock server (GEN-090): a route in the scenario's
 * `httpScript` answers with its latest step that is due, so a page that polls sees the state change.
 */
export function mockHttp(scenario: MockScenario, request: MockRequest, elapsedMs = 0): MockReply {
  const route = findRoute(request.method.toUpperCase(), request.path);
  // Not in the contract: the screens must not call it, so it fails the way an unreachable server does.
  if (!route) return { fail: 'network' };
  const due = (scenario.httpScript?.[routeKey(route)] ?? []).filter((step) => step.afterMs <= elapsedMs).at(-1);
  const reply = due?.reply ?? scenario.http[routeKey(route)] ?? DEFAULTS[routeKey(route)];
  if (reply && !('status' in reply)) return reply;
  if (route.request) {
    const parsed = CONTRACT_SCHEMAS[route.request].safeParse(request.body);
    if (!parsed.success) return invalidInput(parsed.error.issues);
  }
  if (reply) return reply;
  if (route.response === null) return { status: 204, body: null };
  return ok(CONTRACT_FIXTURES[route.response][0]);
}
