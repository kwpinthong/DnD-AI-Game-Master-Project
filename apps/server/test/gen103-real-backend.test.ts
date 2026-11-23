import { ApiError, GameLogResponse, GameRatingResponse, GameLearningResponse, GmConsoleResponse, LearningLibraryResponse } from '@isekai/protocol';
import { CONTRACT, CONTRACT_SCHEMAS, PENDING_FIELDS, type HttpItem } from '@isekai/protocol/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { ensurePhaseState, recordAction, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, startedTable, type Table } from './visibility-fixture.ts';

/**
 * GEN-103: the three pages GEN-091 built on the mock (GM console, end page + rating, Learning library) against the
 * real routes in one run: each answer the page reads goes through the GEN-099 contract schema (C5), and the
 * contract has every endpoint of those pages `ready` (C6).
 */
const ADMIN_CODE = 'ทดสอบ-ต่อจริง-103';
const SCREENS = ['gm-console', 'ending', 'ending-rating', 'learning-library'] as const;
const HTTP = CONTRACT.filter((i): i is HttpItem => i.kind === 'http');
/** `/api/admin/learning/:id` matches `/api/admin/learning/7`. */
const itemFor = (method: string, path: string) =>
  HTTP.find((i) => i.method === method && new RegExp(`^${i.path.replace(/:[^/]+/g, '[^/]+')}$`).test(path.split('?')[0]!));

describe('GEN-103 GM console + end page + Learning library on the real backend', { timeout: 120_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${tmp.dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_RETRY_DELAY_MS: '0', AI_MAX_RETRIES: '0' }), aiLog: () => {}, rng: null },
    );
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** C5: a call the page makes; a 2xx must pass the contract's response schema, anything else ApiError. */
  async function hit(t: Table, method: string, path: string, options: { token?: string; body?: unknown } = {}) {
    const item = itemFor(method, path);
    expect(item, `${method} ${path} is in the contract`).toBeDefined();
    const res = await t.call(method, path, options);
    if (res.status >= 200 && res.status < 300) {
      const parsed = CONTRACT_SCHEMAS[item!.response!].safeParse(res.body);
      expect(parsed.success, `${method} ${path} → ${item!.response}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    } else {
      expect(ApiError.safeParse(res.body).success, `${method} ${path} (${res.status}) → ApiError`).toBe(true);
    }
    return res;
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;

  function end(t: Table) {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
  }

  it('C1 + C5: the GM opens the console and sees every number; a player calling the same API gets 403', async () => {
    const t = await startedTable(server!, true);
    for (const [i, seat] of [t.a, t.b, t.c].entries()) server!.db.prepare('update character set karma = ? where member_id = ?').run(-40 + i * 30, seat.memberId);
    const res = await hit(t, 'GET', '/api/game/gm/console', { token: t.gm!.token });
    expect(res.status).toBe(200);
    const view = GmConsoleResponse.parse(res.body);
    expect(view.characters.map((c) => c.karma)).toEqual([-40, -10, 20]);
    expect(view.characters.map((c) => [c.hp.current, c.hp.max])).toEqual([[100, 100], [100, 100], [100, 100]]);
    expect(view.npcs).toBeDefined(); // the real server sends the NPC curses (no "pending" on the page)
    for (const seat of [t.a, t.b, t.c]) expect((await hit(t, 'GET', '/api/game/gm/console', { token: seat.token })).status).toBe(403);
  });

  it('C2 + C3 + C4 + C5: an ended game shows the secrets, takes the score and the ruling 👍/👎, the learning status follows the ratings, the admin deletes an entry', async () => {
    const t = await startedTable(server!, false);
    recordAction(server!.orm, gameIdOf(t), { day: 1, phase: 'EOSORIA', turn: 1 }, t.b.memberId, { text: 'แอบหยิบถุงเงิน', visibility: 'secret', rest: false }, CLOCK);
    end(t);

    // C2: the secret summary, the score form and the ruling vote all answer.
    const log = GameLogResponse.parse((await hit(t, 'GET', '/api/game/log', { token: t.a.token })).body);
    const secret = log.reveal!.players.find((p) => p.memberId === t.b.memberId)!.secretActions[0]!;
    expect(secret.text).toBe('แอบหยิบถุงเงิน');
    expect(GameRatingResponse.parse((await hit(t, 'GET', '/api/game/rating', { token: t.a.token })).body).rating.mine).toBeNull();
    const rated = GameRatingResponse.parse((await hit(t, 'PUT', '/api/game/rating', { token: t.a.token, body: { score: 9, comment: 'สนุก' } })).body).rating;
    expect(rated.mine).toEqual({ score: 9, comment: 'สนุก' });
    const votePath = `/api/game/rating/votes/${encodeURIComponent(secret.sourceRef!)}`;
    expect(GameRatingResponse.parse((await hit(t, 'PUT', votePath, { token: t.a.token, body: { vote: 'up' } })).body).rating.myVotes).toEqual({ [secret.sourceRef!]: 'up' });
    expect(GameRatingResponse.parse((await hit(t, 'PUT', votePath, { token: t.a.token, body: { vote: 'down' } })).body).rating.myVotes).toEqual({ [secret.sourceRef!]: 'down' });

    // C3: not everyone rated → pending; the last member rates → the extract runs by itself → done.
    const status = async () => GameLearningResponse.parse((await hit(t, 'GET', '/api/game/learning', { token: t.a.token })).body).status;
    expect(await status()).toBe('pending');
    await hit(t, 'PUT', '/api/game/rating', { token: t.b.token, body: { score: 7 } });
    expect(await status()).toBe('pending');
    await hit(t, 'PUT', '/api/game/rating', { token: t.c.token, body: { score: 8 } });
    await vi.waitFor(async () => expect(await status()).toBe('done'), { timeout: 10_000 });

    // C4: the real library holds what this game taught; a deleted entry leaves the list.
    const admin = ((await hit(t, 'POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body as { token: string }).token;
    const before = LearningLibraryResponse.parse((await hit(t, 'GET', '/api/admin/learning', { token: admin })).body);
    const mine = before.entries.filter((e) => e.sourceGameId === gameIdOf(t));
    expect(mine.length).toBeGreaterThan(0);
    const gone = mine[0]!.id;
    const after = LearningLibraryResponse.parse((await hit(t, 'DELETE', `/api/admin/learning/${encodeURIComponent(gone)}`, { token: admin })).body);
    expect(after.entries.map((e) => e.id)).not.toContain(gone);
    expect(LearningLibraryResponse.parse((await hit(t, 'GET', '/api/admin/learning', { token: admin })).body).entries.map((e) => e.id)).not.toContain(gone);
  });

  it('C6: every endpoint and field of the three pages is ready in the contract (docs/contract.md)', () => {
    const items = CONTRACT.filter((i) => i.screens.some((s) => (SCREENS as readonly string[]).includes(s)));
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter((i) => i.status !== 'ready').map((i) => (i.kind === 'http' ? `${i.method} ${i.path}` : i.type))).toEqual([]);
    expect(PENDING_FIELDS.filter((f) => f.screens.some((s) => (SCREENS as readonly string[]).includes(s)))).toEqual([]);
  });
});
