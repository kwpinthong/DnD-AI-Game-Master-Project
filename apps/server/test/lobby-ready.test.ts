import { ApiError, CreateGameResponse, defaultScenario, GameView, JoinResponse, sortTimeline, type RoomServerMessage } from '@isekai/protocol';
import { SeededRng } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import type { RunningServer, ServerOptions } from '../src/server.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, startTestServer, type Call } from './visibility-fixture.ts';

/**
 * ISK-017: no human host. Players press ready (POST /api/game/ready); the server starts the game itself once
 * everyone is ready (Online ≥ 2 players, Single its one player). Settings are given once at creation and locked;
 * the owner-only routes are gone (404).
 */

const AI_WITHOUT_KEY = loadAiConfig({ AI_PROVIDER: 'anthropic' });

interface Seat {
  token: string;
  memberId: string;
}

describe('ISK-017 ready + auto start, no owner', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
  const sockets: RoomClient[] = [];

  async function boot(options: ServerOptions = {}) {
    server = await startTestServer(dir, options);
    call = caller(server);
  }

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    await boot();
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function reboot(options: ServerOptions = {}) {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot(options);
  }

  /** A lobby game: the creator plus `joiners`, each player with a character and a chosen loot, nobody ready. */
  async function lobby(opts: { mode?: 'online' | 'single'; humanGm?: boolean; joiners?: string[]; extra?: Record<string, unknown> } = {}) {
    const created = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'ห้องรอ', mode: opts.mode ?? 'online', humanGm: opts.humanGm ?? false, name: 'นก', pin: '1234', ...opts.extra },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const game = CreateGameResponse.parse(created.body);
    const creator: Seat = { token: game.token, memberId: game.member.id };
    const players: Seat[] = opts.humanGm ? [] : [creator];
    for (const name of opts.joiners ?? []) {
      const res = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name, pin: '1111' } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const joined = JoinResponse.parse(res.body);
      players.push({ token: joined.token, memberId: joined.member.id });
    }
    for (const p of players) seedCharacter(p.memberId);
    return { game, creator, players, gameId: game.game.id, inviteCode: game.game.inviteCode };
  }

  function seedCharacter(memberId: string) {
    server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(memberId, CLOCK);
    seedChosenLoot(server!.db, memberId);
  }

  const ready = (seat: Seat, value = true) => call('POST', '/api/game/ready', { token: seat.token, body: { ready: value } });
  const view = async (seat: Seat) => GameView.parse((await call('GET', '/api/game', { token: seat.token })).body);
  const readyOf = async (seat: Seat) => Object.fromEntries((await view(seat)).members.map((m) => [m.id, m.ready]));
  const startedAt = (gameId: string) => (server!.db.prepare('select started_at as t from game where id = ?').get(gameId) as { t: number | null }).t;

  async function lobbySocket(seat: Seat): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token, lobby: true });
    sockets.push(client);
    return client;
  }

  /**
   * The lobby hello gets no answer, so a socket is known to be registered once it hears a `lobby_ready`: sends
   * `seat`'s current value again (bounded retries) until every watcher heard it.
   */
  async function primed(watchers: RoomClient[], seat: Seat, value: boolean) {
    const heard = (w: RoomClient) => w.messages.some((m) => m.type === 'lobby_ready' && m.memberId === seat.memberId);
    for (let i = 0; i < 20 && !watchers.every(heard); i++) {
      expect((await ready(seat, value)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(watchers.every(heard)).toBe(true);
  }

  it('C1: online, 3 players, 2 ready: the 3rd ready starts the game once; everyone sees it started', async () => {
    const t = await lobby({ joiners: ['บี', 'ซี'] });
    const [a, b, c] = t.players as [Seat, Seat, Seat];
    expect((await ready(a)).status).toBe(200);
    expect((await ready(b)).status).toBe(200);
    expect((await view(a)).status).toBe('lobby');

    const last = await ready(c);
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    expect(GameView.parse(last.body)).toMatchObject({ status: 'started', startBlockers: [] });
    const at = startedAt(t.gameId);
    expect(at).not.toBeNull();
    // The existing start signal: GET /api/game says started for everyone (the lobby polls it).
    for (const s of [a, b, c]) expect((await view(s)).status).toBe('started');
    // A late ready changes nothing: the start happened once.
    expect(ApiError.parse((await ready(a)).body).code).toBe('not_in_lobby');
    expect(startedAt(t.gameId)).toBe(at);
  });

  it('C2: online with one player who is ready does not start', async () => {
    const t = await lobby();
    const res = await ready(t.creator);
    expect(res.status).toBe(200);
    expect(GameView.parse(res.body)).toMatchObject({ status: 'lobby', startBlockers: ['ขาดผู้เล่นอีก 1 คน (Online ต้องมีผู้เล่นอย่างน้อย 2 คน)'] });
    expect(GameView.parse(res.body).members.find((m) => m.id === t.creator.memberId)?.ready).toBe(true);
    expect(startedAt(t.gameId)).toBeNull();
  });

  it('C3: single, its one player ready starts the game', async () => {
    const t = await lobby({ mode: 'single' });
    const res = await ready(t.creator);
    expect(res.status).toBe(200);
    expect(GameView.parse(res.body).status).toBe('started');
  });

  it('C4: a ready taken back blocks the start; a newcomer is not ready and the others stay ready; lobby_ready reaches every lobby socket', async () => {
    const t = await lobby({ humanGm: true, joiners: ['บี', 'ซี', 'ดี'] });
    const [b, c, d] = t.players as [Seat, Seat, Seat];
    const watchers = [await lobbySocket(t.creator), await lobbySocket(b)];
    await primed(watchers, d, false);
    expect((await ready(b)).status).toBe(200);
    expect((await ready(c)).status).toBe(200);
    for (const w of watchers) await w.waitFor((m) => m.type === 'lobby_ready' && m.memberId === c.memberId && m.ready);
    expect((await ready(c, false)).status).toBe(200);
    for (const w of watchers) await w.waitFor((m) => m.type === 'lobby_ready' && m.memberId === c.memberId && !m.ready);
    expect((await ready(d)).status).toBe(200);
    expect((await view(b)).status).toBe('lobby');
    expect(await readyOf(b)).toEqual({ [t.creator.memberId]: false, [b.memberId]: true, [c.memberId]: false, [d.memberId]: true });

    const joined = JoinResponse.parse((await call('POST', '/api/join', { body: { inviteCode: t.inviteCode, name: 'อี', pin: '1111' } })).body);
    const states = await readyOf(b);
    expect(states[joined.member.id]).toBe(false);
    expect(states[b.memberId]).toBe(true);
    expect(states[d.memberId]).toBe(true);
    // A lobby socket gets no room and no `ready`.
    for (const w of watchers) expect(w.messages.filter((m) => m.type === 'room' || m.type === 'ready')).toEqual([]);
  });

  it('C5: the last two ready at the same time: startGame runs once', async () => {
    await reboot({ rng: new SeededRng(7) });
    const t = await lobby({ joiners: ['บี', 'ซี'] });
    const [a, b, c] = t.players as [Seat, Seat, Seat];
    expect((await ready(a)).status).toBe(200);
    const both = await Promise.all([ready(b), ready(c)]);
    for (const res of both) expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(both.map((r) => GameView.parse(r.body).status)).toContain('started');
    expect((await view(a)).status).toBe('started');
    // One start: one origin per player and one private narration each (narrated by the request that started).
    const count = (sql: string) => (server!.db.prepare(sql).get(t.gameId) as { n: number }).n;
    expect(count('select count(*) as n from character_origin where game_id = ?')).toBe(3);
    expect(count("select count(*) as n from ai_usage where game_id = ? and purpose = 'narrate_player'")).toBe(3);
  });

  it('C6: AI GM not ready: the last ready gets 503 + lobby_start_blocked, nothing starts, ready stays; once the AI is ready a ready true starts it', async () => {
    const t = await lobby({ joiners: ['บี'] });
    const [a, b] = t.players as [Seat, Seat];
    expect((await ready(a)).status).toBe(200);
    await reboot({ ai: AI_WITHOUT_KEY });
    const watchers = [await lobbySocket(a), await lobbySocket(b)];
    await primed(watchers, a, true);

    const blocked = await ready(b);
    expect(blocked.status).toBe(503);
    const error = ApiError.parse(blocked.body);
    expect(error.code).toBe('ai_not_ready');
    for (const w of watchers) {
      const event = await w.waitFor((m) => m.type === 'lobby_start_blocked');
      expect(event).toEqual({ type: 'lobby_start_blocked', reason: error.message });
    }
    expect(startedAt(t.gameId)).toBeNull();
    expect(await readyOf(a)).toEqual({ [a.memberId]: true, [b.memberId]: true });

    await reboot();
    const again = await ready(b);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(GameView.parse(again.body).status).toBe('started');
  });

  it('C7: the creator gets 404 for every removed owner route and nothing changes', async () => {
    const t = await lobby({ humanGm: true, joiners: ['บี'] });
    const before = await view(t.creator);
    const scenarioBefore = getGameScenario(server!.orm, t.gameId);
    const [b] = t.players as [Seat];
    const attempts: [string, string, unknown][] = [
      ['PATCH', '/api/game', { gameName: 'ชื่อใหม่', mode: 'single' }],
      ['PUT', '/api/game/scenario', { ...defaultScenario(), name: 'แก้แล้ว' }],
      ['POST', '/api/game/scenario/reset', undefined],
      ['POST', '/api/game/invite-code', undefined],
      ['DELETE', `/api/game/members/${b.memberId}`, undefined],
      ['DELETE', '/api/game', { confirmName: 'ห้องรอ' }],
      ['POST', '/api/game/start', undefined],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, { token: t.creator.token, ...(body === undefined ? {} : { body }) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(await view(t.creator)).toEqual(before);
    expect(getGameScenario(server!.orm, t.gameId)).toEqual(scenarioBefore);
    expect((await call('GET', '/api/me', { token: b.token })).status).toBe(200);
    // GET scenario still reads (the Human GM).
    expect((await call('GET', '/api/game/scenario', { token: t.creator.token })).status).toBe(200);
  });

  it('C8: the create form sets tone, NPC dialogue, memory and scenario once; no scenario = the default; a memory not of the creator\'s code = 409', async () => {
    const CODE = 'nok-isk017';
    const old = await startedTable(server!, false, { playerCode: CODE, gameName: 'เกมเก่า' });
    const oldId = (server!.db.prepare('select game_id as id from member where id = ?').get(old.a.memberId) as { id: string }).id;
    savePhaseState(server!.orm, oldId, { ...ensurePhaseState(server!.orm, oldId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);

    const scenario = { ...defaultScenario(), name: 'เมืองของ ISK-017', timeline: [...defaultScenario().timeline].reverse() };
    const t = await lobby({ humanGm: true, extra: { tone: 'C', npcDialogue: 'high', playerCode: CODE, memory: { enabled: true, sourceGameIds: [oldId] }, scenario } });
    expect(t.game.game).toMatchObject({ tone: 'C', npcDialogue: 'high', memory: { enabled: true, sources: [{ id: oldId, name: 'เกมเก่า' }] } });
    expect(getGameScenario(server!.orm, t.gameId)).toEqual(sortTimeline(scenario));

    const plain = await lobby();
    expect(getGameScenario(server!.orm, plain.gameId)).toEqual(defaultScenario());

    const create = (extra: Record<string, unknown>) =>
      call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'ใหม่', mode: 'single', humanGm: false, name: 'นก', pin: '1234', ...extra } });
    const refused = await create({ playerCode: 'someone-else', memory: { enabled: true, sourceGameIds: [oldId] } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(ApiError.parse(refused.body).code).toBe('not_allowed');
    // A wrong scenario names its field.
    const bad = await create({ scenario: { ...defaultScenario(), timeline: 'nope' } });
    expect(bad.status).toBe(400);
    expect((bad.body as { fields: Record<string, string> }).fields).toHaveProperty('timeline');
  });

  it('C9: ready after the start, and from the Human GM, is 409 not_in_lobby', async () => {
    const t = await lobby({ mode: 'single' });
    expect(GameView.parse((await ready(t.creator)).body).status).toBe('started');
    for (const value of [true, false]) {
      const res = await ready(t.creator, value);
      expect(res.status).toBe(409);
      expect(ApiError.parse(res.body).code).toBe('not_in_lobby');
    }
    const gm = await lobby({ humanGm: true });
    const res = await ready(gm.creator);
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).code).toBe('not_in_lobby');
    expect((await call('POST', '/api/game/ready', { token: gm.creator.token, body: { ready: 'yes' } })).status).toBe(400);
  });

  it('C10: GET /api/game members carry `ready` and no `isOwner` (you neither)', async () => {
    const t = await lobby({ joiners: ['บี'] });
    const body = (await call('GET', '/api/game', { token: t.creator.token })).body as { you: object; members: object[] };
    expect(body.you).not.toHaveProperty('isOwner');
    for (const m of body.members) {
      expect(m).toHaveProperty('ready', false);
      expect(m).not.toHaveProperty('isOwner');
    }
  });

  it('C11: the budget gmStatus reaches every player online in the game, not only the creator', async () => {
    await reboot({ ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_GAME_MONTHLY_USD: '0' }) });
    const t = await startedTable(server!, false);
    const clients = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    const lastRoom = (c: RoomClient) => c.messages.filter((m): m is Extract<RoomServerMessage, { type: 'room' }> => m.type === 'room').at(-1)!;
    for (const c of clients) expect(lastRoom(c).gmStatus).toMatchObject({ code: 'budget_reached', canRetry: false });
  });

  it('C12: an old database with a lobby game that has an owner migrates: the game is whole, nobody ready, and it starts by the new rules', async () => {
    const t = await lobby({ joiners: ['บี'] });
    const [a, b] = t.players as [Seat, Seat];
    await server!.close();
    server = undefined;
    // Back to the schema before ISK-017: no ready_at, and its migration not applied yet.
    const Database = (await import('better-sqlite3')).default;
    const sqlite = new Database(`${dir}/isekai.sqlite`);
    sqlite.prepare('alter table member drop column ready_at').run();
    sqlite.prepare('delete from __drizzle_migrations where id = (select max(id) from __drizzle_migrations)').run();
    const owner = (sqlite.prepare('select owner_member_id as o from game where id = ?').get(t.gameId) as { o: string }).o;
    sqlite.close();
    expect(owner).toBe(a.memberId);

    await boot();
    const after = await view(b);
    expect(after).toMatchObject({ id: t.gameId, name: 'ห้องรอ', status: 'lobby' });
    expect(after.members.map((m) => [m.id, m.ready, m.hasCharacter])).toEqual([
      [a.memberId, false, true],
      [b.memberId, false, true],
    ]);
    expect((await ready(b)).status).toBe(200);
    expect(GameView.parse((await ready(a)).body).status).toBe('started');
  });
});
