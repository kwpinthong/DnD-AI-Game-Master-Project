import { defaultScenario, GameTimelineResponse, type RoomServerMessage } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import { game } from '../src/db/schema.ts';
import type { NarrationContext, TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf } from '../src/gm/mock-gm.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { copyTemplateForGame, getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { buildEventContext } from '../src/timeline/context.ts';
import { advanceTimeline, eventWitnesses } from '../src/timeline/store.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** GEN-097 (Q-160): an event at several places; whoever is at any of them when it starts witnesses it (Q-104). */

const placeName = (id: string) => defaultScenario().locations.find((l) => l.id === id)!.name;

describe('GEN-097 witnesses and the player timeline', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    server = await startTestServer(dataDir);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const gameOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const seen = async (t: Table, who: Seat) =>
    GameTimelineResponse.parse((await t.call('GET', '/api/game/timeline', { token: who.token })).body).events.map((e) => e.id);

  it('C1: day 7 at two places: people at both see it when it starts; the market does not', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameOf(t);
    const scenario = getGameScenario(server!.orm, gameId)!;
    const timeline = scenario.timeline.map((e) => (e.id === 'd7-kidnapping' ? { ...e, locationIds: ['fountain', 'temple'] } : e));
    expect(updateGameScenario(server!.orm, gameId, { ...scenario, timeline }).ok).toBe(true);

    move(t.a, 'temple');
    move(t.b, 'fountain');
    move(t.c, 'market');
    advanceTimeline(server!.orm, gameId, { day: 7, phase: 'HESPERION' }, CLOCK);
    expect([...(eventWitnesses(server!.orm, gameId).get('d7-kidnapping') ?? [])].sort()).toEqual([t.a.memberId, t.b.memberId].sort());
    expect(await seen(t, t.a)).toContain('d7-kidnapping');
    expect(await seen(t, t.b)).toContain('d7-kidnapping');
    expect(await seen(t, t.c)).not.toContain('d7-kidnapping');

    // Someone who arrives at one of the places later does not see it (Q-104).
    move(t.c, 'temple');
    expect(await seen(t, t.c)).not.toContain('d7-kidnapping');
  });

  it('C1 / C6: the sheet day 10 event (temple / fountain) is seen at both places', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameOf(t);
    move(t.a, 'temple');
    move(t.b, 'fountain');
    move(t.c, 'market');
    advanceTimeline(server!.orm, gameId, { day: 10, phase: 'NOCTHERION' }, CLOCK);
    expect(await seen(t, t.a)).toContain('d10-summoning');
    expect(await seen(t, t.b)).toContain('d10-summoning');
    expect(await seen(t, t.c)).not.toContain('d10-summoning');
  });

  it('C3: a town-wide event is seen by everyone, wherever they are', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameOf(t);
    move(t.a, 'temple');
    move(t.c, 'market');
    advanceTimeline(server!.orm, gameId, { day: 5, phase: 'EOSORIA' }, CLOCK);
    expect(eventWitnesses(server!.orm, gameId).get('d5-disaster')).toBeNull();
    for (const who of [t.a, t.b, t.c]) expect(await seen(t, who)).toContain('d5-disaster');
  });
});

describe('GEN-097 C2: a stored scenario with one locationId', () => {
  let opened: OpenedDatabase;
  let cleanup = () => {};
  const GAME = 'game-a';

  beforeEach(() => {
    const temp = makeTempDir();
    cleanup = temp.cleanup;
    opened = openDatabase(join(temp.dir, 'isekai.sqlite'));
    opened.db.insert(game).values({ id: GAME, inviteCode: 'CODEA', createdAt: 1 }).run();
    copyTemplateForGame(opened.db, GAME);
  });

  afterEach(() => {
    opened.sqlite.close();
    cleanup();
  });

  it('loads as a list of one place and works as before', () => {
    const old = defaultScenario() as unknown as { timeline: Record<string, unknown>[] };
    for (const e of old.timeline) {
      e.locationId = Array.isArray(e.locationIds) ? e.locationIds[0] : null;
      delete e.locationIds;
    }
    opened.sqlite.prepare('update game_scenario set data = ? where game_id = ?').run(JSON.stringify(old), GAME);

    const scenario = getGameScenario(opened.db, GAME)!;
    expect(scenario.timeline.find((e) => e.id === 'd7-kidnapping')!.locationIds).toEqual(['temple']);
    expect(scenario.timeline.find((e) => e.id === 'd5-disaster')!.locationIds).toBeNull();

    advanceTimeline(opened.db, GAME, { day: 7, phase: 'HESPERION' });
    expect(buildEventContext(opened.db, GAME, 7, 'HESPERION').active[0]).toMatchObject({ id: 'd7-kidnapping', places: [placeName('temple')] });
  });
});

describe('GEN-097 C4: the AI GM context', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  const requests: AiCallRequest[] = [];

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    requests.length = 0;
    const provider: AiProvider = {
      id: 'mock',
      ready: () => ({ ok: true }),
      estimateTokens: (text) => Math.ceil(text.length / 3),
      async call(req) {
        requests.push(req);
        return { ...mockReply.ok(await cannedGmAnswer(req)), model: req.model };
      },
    };
    server = await startTestServer(dataDir, {
      aiProvider: provider,
      ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }),
    });
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  it('the place narration at the temple and the fountain carries the day 10 event; the market one does not', async () => {
    const t = await startedTable(server!, false);
    const gameId = (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    for (const [who, place] of [[t.a, 'temple'], [t.b, 'fountain'], [t.c, 'market']] as const) {
      expect(moveCharacter(server!.orm, who.memberId, place, CLOCK)).toBe(true);
    }
    const to = { day: 10, phase: 'NOCTHERION', turn: 1 } as const;
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...to }, CLOCK);
    advanceTimeline(server!.orm, gameId, to, CLOCK);

    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const client = await openRoom(server!, { token: seat.token });
      sockets.push(client);
      await client.waitFor(isReady);
      clients.push(client);
    }
    for (const client of clients) {
      const from = client.messages.length;
      client.action('มองไปรอบ ๆ', 'public');
      expect(await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    for (const client of clients) {
      await client.waitFor((m: RoomServerMessage) => m.type === 'room' && m.day === 10 && m.turn === 2 && m.status === 'collecting');
    }

    const turn = contextOf<TurnContext>(requests.find((r) => r.output.name === 'gm_turn_proposal')!);
    expect(turn.events.active.find((e) => e.id === 'd10-summoning')).toMatchObject({ places: [placeName('temple'), placeName('fountain')] });

    const placeFeeds = new Map(
      requests
        .filter((r) => r.output.name === 'gm_narration')
        .map((r) => contextOf<NarrationContext>(r))
        .filter((c) => 'place' in c.audience)
        .map((c) => [(c.audience as { place: string }).place, c.beats.map((b) => b.actionId)]),
    );
    expect(placeFeeds.get('temple')).toContain('event:d10-summoning');
    expect(placeFeeds.get('fountain')).toContain('event:d10-summoning');
    expect(placeFeeds.get('market')).toBeDefined();
    expect(placeFeeds.get('market')).not.toContain('event:d10-summoning');
  });
});
