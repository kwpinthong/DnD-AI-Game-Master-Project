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
  /** The bearer token sent, for the scenario's `byToken` answers (ISK-022). */
  token?: string;
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

/** ISK-011: three reports, one of each type and status, for the owner's ฟีดแบ็ก tab. */
const [REPORT, HTML_REPORT] = CONTRACT_FIXTURES.FeedbackRow;
const REPORTS = [
  REPORT!,
  { ...REPORT!, id: 9, type: 'other' as const, status: 'reviewing' as const, text: `${'ตอนเปลี่ยนช่วงเวลา หน้าจอกระพริบแล้วข้อความที่พิมพ์ไว้หายไป '.repeat(3)}เกิดบนมือถือ` },
  HTML_REPORT!,
];

/** Defaults for every scenario: the game has started (so the app goes on to the play room). */
const DEFAULTS: Readonly<Record<string, MockReply>> = {
  'GET /api/game': ok(CONTRACT_FIXTURES.GameView[1]),
  // GEN-091: a delete answers with what is left, so the library visibly loses the entry / the game.
  'DELETE /api/admin/learning/:id': ok({ entries: LIBRARY.entries.slice(1), counts: { ...LIBRARY.counts, [LIBRARY.entries[0]!.type]: 0 } }),
  'DELETE /api/admin/learning/games/:gameId': ok(CONTRACT_FIXTURES.LearningLibraryResponse[1]),
  'GET /api/admin/feedback': ok({ feedback: REPORTS }),
};

const FEEDBACK_STATUS = 'PATCH /api/admin/feedback/:id';

/** ISK-011: a status change answers with that report holding the sent status (the default fixture is another report). */
function feedbackStatusReply(request: MockRequest): MockReply {
  const id = Number(request.path.split('/').pop());
  const found = REPORTS.find((r) => r.id === id);
  if (!found) return { status: 404, body: { code: 'feedback_not_found', message: 'ไม่พบรายงานนี้' } };
  return ok({ ...found, status: (request.body as { status: string }).status });
}

const RULING_VOTE = 'PUT /api/game/rating/votes/:sourceRef';

/** GEN-171: a ruling vote answers with the scenario's rating where this ruling holds the sent vote (👍, 👎 or none). */
function rulingVoteReply(scenario: MockScenario, request: MockRequest): MockReply {
  const shown = scenario.http['GET /api/game/rating'];
  const base = (shown && 'status' in shown ? shown.body : CONTRACT_FIXTURES.GameRatingResponse[0]) as (typeof CONTRACT_FIXTURES.GameRatingResponse)[number];
  const ref = decodeURIComponent(request.path.split('/').pop()!);
  const { vote } = request.body as { vote: 'up' | 'down' | null };
  const { [ref]: _gone, ...others } = base.rating.myVotes;
  return ok({ rating: { ...base.rating, myVotes: vote ? { ...others, [ref]: vote } : others } });
}

const CLOSE_GAME = 'POST /api/admin/games/:id/close';

/** ISK-002: a close answers with the closed game's row from the scenario's list (or the default fixture list). */
function closeGameReply(scenario: MockScenario, request: MockRequest): MockReply {
  const shown = scenario.http['GET /api/admin/games'];
  const list = (shown && 'status' in shown ? shown.body : CONTRACT_FIXTURES.AdminGamesResponse[0]) as (typeof CONTRACT_FIXTURES.AdminGamesResponse)[number];
  const id = decodeURIComponent(request.path.split('/').at(-2)!);
  const game = list.games.find((g) => g.id === id) ?? CONTRACT_FIXTURES.AdminGameRow[0]!;
  return ok({ ...game, phase: 'ended', endedReason: 'closed' });
}

const KICK = 'POST /api/admin/games/:id/members/:memberId/kick';

/** ISK-020: a kick answers with the scenario's members (or the default fixture) where that member is now kicked. */
function kickReply(scenario: MockScenario, request: MockRequest): MockReply {
  const shown = scenario.http['GET /api/admin/games/:id/members'];
  const list = (shown && 'status' in shown && shown.status === 200 ? shown.body : CONTRACT_FIXTURES.AdminMembersResponse[0]) as (typeof CONTRACT_FIXTURES.AdminMembersResponse)[number];
  const id = decodeURIComponent(request.path.split('/').at(-2)!);
  return ok({ members: list.members.map((m) => (m.id === id ? { ...m, kickedAt: new Date().toISOString() } : m)) });
}

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
  const byToken = request.token === undefined ? undefined : scenario.byToken?.[request.token]?.[routeKey(route)];
  const reply = due?.reply ?? byToken ?? scenario.http[routeKey(route)] ?? DEFAULTS[routeKey(route)];
  if (reply && !('status' in reply)) return reply;
  if (route.request) {
    const parsed = CONTRACT_SCHEMAS[route.request].safeParse(request.body);
    if (!parsed.success) return invalidInput(parsed.error.issues);
  }
  if (reply) return reply;
  if (routeKey(route) === RULING_VOTE) return rulingVoteReply(scenario, request);
  if (routeKey(route) === CLOSE_GAME) return closeGameReply(scenario, request);
  if (routeKey(route) === KICK) return kickReply(scenario, request);
  if (routeKey(route) === FEEDBACK_STATUS) return feedbackStatusReply(request);
  if (route.response === null) return { status: 204, body: null };
  return ok(CONTRACT_FIXTURES[route.response][0]);
}
