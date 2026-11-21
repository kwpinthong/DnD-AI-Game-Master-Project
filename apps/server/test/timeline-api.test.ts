import { CreateGameResponse, defaultScenario, GameTimelineResponse, JoinResponse } from '@isekai/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { advanceTimeline, getTimeline, setEventOutcome } from '../src/timeline/store.ts';
import { makeTempDir } from './helpers.ts';

const CREATE_CODE = 'ลับเฉพาะ-2026';
const MOCK_AI = loadAiConfig({ AI_PROVIDER: 'mock' });

describe('timeline over the API: start = day 1 Morning, players see no future event, restart-safe (GEN-053)', { timeout: 60_000 }, () => {
  let createCodeHash = '';
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeAll(async () => {
    createCodeHash = await hashPin(CREATE_CODE);
  });

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function start() {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash },
      { ai: MOCK_AI, aiLog: () => {} },
    );
    return server;
  }

  async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const res = await fetch(`${server!.url}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : undefined) as unknown };
  }

  /** Characters are created by GEN-047; here a character row is seeded straight into the table. */
  const seedCharacter = (memberId: string) =>
    server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(memberId, Date.now());

  /** An Online game with a Human GM and two players, started. */
  async function startedGame() {
    const created = CreateGameResponse.parse(
      (
        await call('POST', '/api/games', {
          body: { createCode: CREATE_CODE, gameName: 'เมือง', mode: 'online', humanGm: true, name: 'ต้น', pin: '1234' },
        })
      ).body,
    );
    const players = [];
    for (const name of ['นก', 'ปลา']) {
      const joined = JoinResponse.parse(
        (await call('POST', '/api/join', { body: { inviteCode: created.game.inviteCode, name, pin: '1111' } })).body,
      );
      seedCharacter(joined.member.id);
      players.push(joined);
    }
    const started = await call('POST', '/api/game/start', { token: created.token });
    expect(started.status, started.text).toBe(200);
    return { gameId: created.member.gameId, gm: created.token, player: players[0]!.token };
  }

  it('C1: starting the game enters day 1 Morning and the day 1 event becomes active', async () => {
    await start();
    const { gameId, player } = await startedGame();

    const timeline = getTimeline(server!.orm, gameId)!;
    expect(timeline.at).toEqual({ day: 1, phase: 'MORNING' });
    expect(timeline.events.filter((e) => e.status === 'active').map((e) => e.id)).toEqual(['d1-bread']);

    const res = await call('GET', '/api/game/timeline', { token: player });
    expect(res.status).toBe(200);
    expect(GameTimelineResponse.parse(res.body)).toEqual({
      view: 'player',
      at: { day: 1, phase: 'MORNING' },
      ended: false,
      events: [{ id: 'd1-bread', day: 1, phase: 'MORNING', title: defaultScenario().timeline[0]!.title, status: 'active' }],
    });
  });

  it('C5: a player calling the API sees nothing of events that have not happened yet', async () => {
    await start();
    const { gameId, player, gm } = await startedGame();
    advanceTimeline(server!.orm, gameId, { day: 3, phase: 'NIGHT' });

    const scenario = defaultScenario();
    const future = scenario.timeline.filter((e) => e.day > 3);
    for (const path of ['/api/game/timeline', '/api/game', '/api/me']) {
      const res = await call('GET', path, { token: player });
      if (res.status === 404) continue;
      expect(res.status, path).toBe(200);
      for (const event of future) {
        expect(res.text, `${path} ${event.id}`).not.toContain(event.id);
        expect(res.text, `${path} ${event.id}`).not.toContain(event.title);
        if (event.description) expect(res.text, `${path} ${event.id}`).not.toContain(event.description);
      }
    }
    const view = GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token: player })).body);
    expect(view.events.map((e) => [e.id, e.status])).toEqual([
      ['d1-bread', 'resolved'],
      ['d2-first-companion', 'resolved'],
      ['d3-cult-clue', 'active'],
    ]);
    // Even past events show only their public title: no description, outcome or GM note.
    expect(JSON.stringify(view)).not.toContain(scenario.timeline[0]!.description);

    // The Human GM sees the whole timeline.
    const gmView = GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token: gm })).body);
    expect(gmView.view).toBe('gm');
    expect(gmView.events).toHaveLength(scenario.timeline.length);

    expect((await call('GET', '/api/game/timeline')).status).toBe(401);
  });

  it('C6: event status and outcome are the same after a server restart', async () => {
    await start();
    const { gameId, gm } = await startedGame();
    advanceTimeline(server!.orm, gameId, { day: 7, phase: 'NIGHT' });
    expect(setEventOutcome(server!.orm, gameId, 'd7-kidnapping', 'prevented')).toEqual({ ok: true });
    const before = (await call('GET', '/api/game/timeline', { token: gm })).body;
    const stateBefore = getTimeline(server!.orm, gameId);

    await server!.close();
    await start();

    expect(getTimeline(server!.orm, gameId)).toEqual(stateBefore);
    expect((await call('GET', '/api/game/timeline', { token: gm })).body).toEqual(before);
    const kidnapping = GameTimelineResponse.parse(before).events.find((e) => e.id === 'd7-kidnapping');
    expect(kidnapping).toMatchObject({ status: 'active', outcome: 'prevented', outcomeSource: 'ai' });

    // And it carries on from there.
    advanceTimeline(server!.orm, gameId, { day: 8, phase: 'MORNING' });
    expect(getTimeline(server!.orm, gameId)!.events.find((e) => e.id === 'd7-kidnapping')).toMatchObject({
      status: 'resolved',
      outcome: 'prevented',
    });
  });
});
