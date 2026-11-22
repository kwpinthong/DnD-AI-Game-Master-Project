import { CreateGameResponse, defaultScenario, GameTimelineResponse, JoinResponse } from '@isekai/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { advanceTimeline, getTimeline, setEventOutcome } from '../src/timeline/store.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';

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
      // rng null: no start scenarios (GEN-065); these tests place the players themselves.
      { ai: MOCK_AI, aiLog: () => {}, rng: null },
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
  const seedCharacter = (memberId: string) => {
    server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(memberId, Date.now());
    seedChosenLoot(server!.db, memberId);
  };

  /** Places a character before the game starts (start leaves placed characters where they are). */
  const seedPresence = (memberId: string, gameId: string, locationId: string) =>
    server!.db
      .prepare('insert into character_presence (member_id, game_id, ref, location_id, updated_at) values (?, ?, ?, ?, ?)')
      .run(memberId, gameId, `ref-${memberId}`, locationId, Date.now());

  /**
   * An Online game with a Human GM and three players, started. The first player is at the fountain when
   * the game starts, so it witnesses d1-bread (fountain, day 1 Morning); the others start at the inn.
   */
  async function startedGame(beforeStart: (gameId: string) => void = () => {}) {
    const created = CreateGameResponse.parse(
      (
        await call('POST', '/api/games', {
          body: { createCode: CREATE_CODE, gameName: 'เมือง', mode: 'online', humanGm: true, name: 'ต้น', pin: '1234' },
        })
      ).body,
    );
    const gameId = created.member.gameId;
    const players = [];
    for (const name of ['นก', 'ปลา', 'ฟ้า']) {
      const joined = JoinResponse.parse(
        (await call('POST', '/api/join', { body: { inviteCode: created.game.inviteCode, name, pin: '1111' } })).body,
      );
      seedCharacter(joined.member.id);
      players.push(joined);
    }
    seedPresence(players[0]!.member.id, gameId, 'fountain');
    beforeStart(gameId);
    const started = await call('POST', '/api/game/start', { token: created.token });
    expect(started.status, started.text).toBe(200);
    return {
      gameId,
      gm: created.token,
      player: players[0]!.token,
      members: players.map((p) => ({ id: p.member.id, token: p.token })),
    };
  }

  const seenIds = async (token: string) =>
    GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token })).body).events.map((e) => e.id);

  it('C1: starting the game enters day 1 Morning and the day 1 event becomes active', async () => {
    await start();
    const { gameId, player } = await startedGame();

    const timeline = getTimeline(server!.orm, gameId)!;
    expect(timeline.at).toEqual({ day: 1, phase: 'EOSORIA' });
    expect(timeline.events.filter((e) => e.status === 'active').map((e) => e.id)).toEqual(['d1-bread']);

    const res = await call('GET', '/api/game/timeline', { token: player });
    expect(res.status).toBe(200);
    expect(GameTimelineResponse.parse(res.body)).toEqual({
      view: 'player',
      at: { day: 1, phase: 'EOSORIA' },
      ended: false,
      events: [{ id: 'd1-bread', day: 1, phase: 'EOSORIA', title: defaultScenario().timeline[0]!.title, status: 'active' }],
    });
  });

  it('C5: a player calling the API sees nothing of events that have not happened yet', async () => {
    await start();
    const { gameId, player, gm } = await startedGame();
    advanceTimeline(server!.orm, gameId, { day: 5, phase: 'EOSORIA' });

    const scenario = defaultScenario();
    const future = scenario.timeline.filter((e) => e.day > 5);
    for (const path of ['/api/game/timeline', '/api/game', '/api/me']) {
      const res = await call('GET', path, { token: player });
      if (res.status === 404) continue;
      expect(res.status, path).toBe(200);
      for (const event of future) {
        expect(res.text, `${path} ${event.id}`).not.toContain(event.id);
        expect(res.text, `${path} ${event.id}`).not.toContain(event.title);
        for (const secret of [event.description, event.outcome, event.interventionEffects, event.foreshadowing]) {
          if (secret) expect(res.text, `${path} ${event.id}`).not.toContain(secret);
        }
      }
    }
    const view = GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token: player })).body);
    expect(view.events.map((e) => [e.id, e.status])).toEqual([
      ['d1-bread', 'resolved'],
      ['d5-disaster', 'active'],
    ]);
    // Even past events show only their public title: no outcome, intervention effects or GM note.
    for (const secret of [scenario.timeline[0]!.outcome, scenario.timeline[0]!.interventionEffects]) {
      expect(JSON.stringify(view)).not.toContain(secret);
    }

    // The Human GM sees the whole timeline.
    const gmView = GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token: gm })).body);
    expect(gmView.view).toBe('gm');
    expect(gmView.events).toHaveLength(scenario.timeline.length);

    expect((await call('GET', '/api/game/timeline')).status).toBe(401);
  });

  it('C6: event status and outcome are the same after a server restart', async () => {
    await start();
    const { gameId, gm } = await startedGame();
    advanceTimeline(server!.orm, gameId, { day: 7, phase: 'HESPERION' });
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
    advanceTimeline(server!.orm, gameId, { day: 8, phase: 'EOSORIA' });
    expect(getTimeline(server!.orm, gameId)!.events.find((e) => e.id === 'd7-kidnapping')).toMatchObject({
      status: 'resolved',
      outcome: 'prevented',
    });
  });

  describe('Q-104: players see the events they were at when the event began (snapshot, like witnessesOf)', () => {
    it('a player who moves away keeps seeing the event, while it is active and after it resolves', async () => {
      await start();
      const { gameId, members } = await startedGame();
      const [a] = members;
      expect(await seenIds(a!.token)).toEqual(['d1-bread']);

      moveCharacter(server!.orm, a!.id, 'inn', Date.now());
      expect(await seenIds(a!.token)).toEqual(['d1-bread']);

      advanceTimeline(server!.orm, gameId, { day: 2, phase: 'EOSORIA' });
      const view = GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token: a!.token })).body);
      expect(view.events.map((e) => [e.id, e.status])).toEqual([['d1-bread', 'resolved']]);
    });

    it('a player who arrives after the event began does not see it, now or after it resolves', async () => {
      await start();
      const { gameId, members } = await startedGame();
      const [a, b, c] = members;
      moveCharacter(server!.orm, b!.id, 'fountain', Date.now());
      expect(await seenIds(b!.token)).toEqual([]);

      // d7-kidnapping (temple, day 7 HESPERION): A is there when it begins, C arrives after.
      moveCharacter(server!.orm, a!.id, 'temple', Date.now());
      advanceTimeline(server!.orm, gameId, { day: 7, phase: 'HESPERION' });
      moveCharacter(server!.orm, c!.id, 'temple', Date.now());
      const townWide = ['d5-disaster'];
      expect(await seenIds(a!.token)).toEqual(['d1-bread', ...townWide, 'd7-kidnapping']);
      expect(await seenIds(b!.token)).toEqual(townWide);
      expect(await seenIds(c!.token)).toEqual(townWide);

      advanceTimeline(server!.orm, gameId, { day: 7, phase: 'NOCTHERION' });
      expect(await seenIds(c!.token)).toEqual(townWide);
      expect(await seenIds(a!.token)).toContain('d7-kidnapping');
    });

    it('an event the game skipped past is seen by whoever was at its place when it happened', async () => {
      await start();
      const { gameId, members } = await startedGame();
      const [a, b] = members;
      moveCharacter(server!.orm, a!.id, 'temple', Date.now());
      advanceTimeline(server!.orm, gameId, { day: 8, phase: 'EOSORIA' });
      moveCharacter(server!.orm, b!.id, 'temple', Date.now());
      expect(await seenIds(a!.token)).toContain('d7-kidnapping');
      expect(await seenIds(b!.token)).not.toContain('d7-kidnapping');
    });

    it('a day 1 Morning event at the starting place is seen by everyone the start places there', async () => {
      await start();
      const { members } = await startedGame((gameId) => {
        const scenario = getGameScenario(server!.orm, gameId)!;
        const timeline = scenario.timeline.map((e) => (e.id === 'd1-bread' ? { ...e, locationId: scenario.locations[0]!.id } : e));
        expect(updateGameScenario(server!.orm, gameId, { ...scenario, timeline }).ok).toBe(true);
      });
      const [a, b, c] = members;
      // A was placed at the fountain before the start, so it missed it; B and C start at the inn.
      expect(await seenIds(a!.token)).toEqual([]);
      expect(await seenIds(b!.token)).toEqual(['d1-bread']);
      expect(await seenIds(c!.token)).toEqual(['d1-bread']);
    });

    it('the Human GM still sees every event with its outcome', async () => {
      await start();
      const { gameId, gm, members } = await startedGame();
      moveCharacter(server!.orm, members[0]!.id, 'inn', Date.now());
      advanceTimeline(server!.orm, gameId, { day: 5, phase: 'EOSORIA' });
      const view = GameTimelineResponse.parse((await call('GET', '/api/game/timeline', { token: gm })).body);
      const state = getTimeline(server!.orm, gameId)!;
      expect(view).toEqual({ view: 'gm', at: state.at, ended: false, events: state.events });
      expect(view.events).toHaveLength(defaultScenario().timeline.length);
    });

    it('the snapshot survives a server restart', async () => {
      await start();
      const { members } = await startedGame();
      const [a, b] = members;
      moveCharacter(server!.orm, a!.id, 'inn', Date.now());
      moveCharacter(server!.orm, b!.id, 'fountain', Date.now());

      await server!.close();
      await start();

      expect(await seenIds(a!.token)).toEqual(['d1-bread']);
      expect(await seenIds(b!.token)).toEqual([]);
    });

    it('an event that began before the snapshot existed (no witnesses) falls back to where players are now (Q-080)', async () => {
      await start();
      const { gameId, members } = await startedGame();
      const [a, b] = members;
      server!.db.prepare('update game_event_state set witnesses = null where game_id = ?').run(gameId);
      moveCharacter(server!.orm, a!.id, 'inn', Date.now());
      moveCharacter(server!.orm, b!.id, 'fountain', Date.now());
      expect(await seenIds(a!.token)).toEqual([]);
      expect(await seenIds(b!.token)).toEqual(['d1-bread']);
    });
  });
});
