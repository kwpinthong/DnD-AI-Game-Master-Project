import type { RoomServerMessage, RoomState } from '@isekai/protocol';
import { ReplayRng, type PhaseAction, type ResolutionProposal, type TagClaim } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { createMockProvider, mockReply, type MockProvider, type MockScript } from '../src/ai/providers/mock.ts';
import { loadGameAssets } from '../src/assets/load.ts';
import { locationSources } from '../src/assets/tags.ts';
import { applyPhaseActions } from '../src/crossplayer/phase.ts';
import { weatherTagging } from '../src/crossplayer/tags.ts';
import type { RunningServer, ServerOptions } from '../src/server.ts';
import { currentWeather, weatherAt } from '../src/weather/service.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/** GEN-068: each period's weather, picked by the AI GM (Mock) within the server's limits, and its rules. */

const assets = loadGameAssets();
const church = assets.location('โบสถ์') ?? expect.fail('no Location โบสถ์');
const noEffects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };

function action(who: Seat, actionId: string, patch: Partial<ResolutionProposal> = {}, tagging?: TagClaim): PhaseAction {
  const proposal: ResolutionProposal = {
    actionId,
    kind: 'general',
    tags: [],
    opposed: false,
    staminaCost: 3,
    visibility: 'public',
    target: null,
    check: { type: 'dc', dc: 11 },
    modifiers: [],
    witnessNpcIds: [],
    repDeltaIfCaught: 0,
    onSuccess: noEffects,
    onFail: noEffects,
    reason: 'test action',
    ...(tagging ? { tagging } : {}),
    ...patch,
  };
  return { actorId: who.memberId, proposal, targetPlayer: null, moveTo: null, awareness: 'normal' };
}

const hasWeather = (m: RoomServerMessage): m is RoomState => m.type === 'room' && m.weather !== null;

describe('GEN-068 weather per period', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function table(options: ServerOptions = {}): Promise<Table & { gameId: string }> {
    server = await startTestServer(dataDir, options);
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    return { ...t, gameId };
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  const scripted = (steps: MockScript['steps']): MockProvider =>
    createMockProvider(loadAiConfig({ AI_PROVIDER: 'mock' }), { steps });
  const weatherCalls = () => server!.db.prepare("select count(*) as n from ai_usage where purpose in ('gm_weather', 'gm_repair')").get() as { n: number };
  const setPlace = (gameId: string, name: string) =>
    server!.db.prepare("update game_scenario set data = json_set(data, '$.locations[0].name', ?) where game_id = ?").run(name, gameId);
  const stamina = (who: Seat) => (server!.db.prepare('select stamina from character where member_id = ?').get(who.memberId) as { stamina: number }).stamina;

  it('C1: a new period gets the Mock weather; it is stored and everyone in town sees the same value', async () => {
    const t = await table();
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    const seen = await Promise.all([a, b, c].map((s) => s.waitFor(hasWeather)));
    expect(seen.map((r) => r.weather)).toEqual([0, 1, 2].map(() => ({ weather: 'Rain', disaster: false })));
    expect(weatherAt(server!.orm, t.gameId, { day: 1, phase: 'EOSORIA' })).toEqual({ weather: 'Rain', disaster: false, source: 'ai' });
    expect(weatherCalls().n).toBe(1);

    // Two turns later SOLARION opens with its own weather, again one value for all.
    for (const round of [1, 2]) {
      const from = a.messages.length;
      for (const s of [a, b, c]) s.action(`รอบ ${round}`, 'public');
      await a.waitFor((m) => m.type === 'room' && m.turn === (round === 1 ? 2 : 1) && m.status === 'collecting', from);
    }
    const solarion = (m: RoomServerMessage) => m.type === 'room' && m.phase === 'SOLARION' && m.weather !== null;
    const next = await Promise.all([a, b, c].map((s) => s.waitFor(solarion)));
    expect(next.map((r) => r.type === 'room' && r.weather)).toEqual([0, 1, 2].map(() => ({ weather: 'Fog', disaster: false })));
    expect(currentWeather(server!.orm, t.gameId)).toMatchObject({ weather: 'Fog' });
    expect(weatherCalls().n).toBe(2);
  });

  it('C2: Dark Night for EOSORIA gets one repair; the repaired answer stands', async () => {
    const provider = scripted([mockReply.ok({ weather: 'Dark Night' }), mockReply.ok({ weather: 'Storm' })]);
    const t = await table({ aiProvider: provider });
    expect(await server!.weather.ensure(t.gameId, { day: 1, phase: 'EOSORIA' })).toEqual({ weather: 'Storm', disaster: false, source: 'repair' });
    expect(provider.requests.map((r) => r.purpose)).toEqual(['gm_weather', 'gm_repair']);
    expect(provider.requests[1]!.messages.at(-1)!.text).toContain('Dark Night');
  });

  it('C2: still wrong after the repair (a value not in the list) -> Clear, and the game goes on', async () => {
    const provider = scripted([mockReply.ok({ weather: 'Sunny' }), mockReply.ok({ weather: 'Clear Night' })]);
    const t = await table({ aiProvider: provider });
    const a = await enter(t.a);
    expect((await a.waitFor(hasWeather)).weather).toEqual({ weather: 'Clear', disaster: false });
    expect(weatherAt(server!.orm, t.gameId, { day: 1, phase: 'EOSORIA' })).toMatchObject({ weather: 'Clear', source: 'fallback' });
    expect(provider.requests).toHaveLength(2);
    a.action('เดินเล่น', 'public');
    expect(await a.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected')).toEqual({ type: 'action_accepted' });
  });

  it('C2: the AI fails -> Clear, with no repair', async () => {
    const provider = scripted(Array.from({ length: 10 }, () => mockReply.fail('provider_error')));
    const t = await table({ aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_RETRY_DELAY_MS: '0' }) });
    expect(await server!.weather.ensure(t.gameId, { day: 2, phase: 'HESPERION' })).toEqual({ weather: 'Clear', disaster: false, source: 'fallback' });
    expect(provider.requests.every((r) => r.purpose === 'gm_weather')).toBe(true);
  });

  it('C5: โบสถ์ on a Dark Night: verb RITUAL gets the Weather_Verb_Boost +2, verb PRAY does not', async () => {
    const t = await table();
    setPlace(t.gameId, 'โบสถ์');
    const night = weatherTagging(assets, 1, 'HESPERION', { weather: 'Dark Night', disaster: false });
    const bonuses = (verb: string, id: string) => {
      const r = applyPhaseActions(server!.orm, t.gameId, [action(t.a, id, {}, { verbTags: [verb], targetTags: [], activate: [] })], new ReplayRng([10, 10]), CLOCK, night);
      if (!r.ok) return expect.fail(JSON.stringify(r.errors));
      const o = r.log.outcomes[0]!;
      return o.status === 'resolved' ? (o.log.tagging?.bonuses ?? []) : expect.fail(o.status);
    };
    expect(bonuses('RITUAL', 'r1')).toEqual([{ kind: 'location', ref: 'location:โบสถ์:Dark Night', trigger: 'passive', value: 2 }]);
    expect(bonuses('PRAY', 'p1')).toEqual([]);
    // Under Clear it is the other way round; Clear also covers Clear Morning (Q-132).
    expect(locationSources(church, ['Clear Morning']).flatMap((s) => s.verbTags)).toEqual(['PRAY']);
  });

  it('C3 / C4: Clear + Secret logs d20 -2 from the weather; Rain at an OUTDOOR place costs 1 more Stamina', async () => {
    const t = await table();
    setPlace(t.gameId, 'น้ำพุกลางเมือง');
    const sunny = applyPhaseActions(server!.orm, t.gameId, [action(t.a, 's1', { visibility: 'secret' })], new ReplayRng([10, 10]), CLOCK, weatherTagging(assets, 1, 'SOLARION', { weather: 'Clear', disaster: false }));
    if (!sunny.ok) return expect.fail(JSON.stringify(sunny.errors));
    const o = sunny.log.outcomes[0]!;
    if (o.status !== 'resolved') return expect.fail(o.status);
    expect(o.log.check?.modifiers).toContainEqual({ source: 'weather', ref: 'Clear:secret', value: -2 });

    const before = stamina(t.b);
    const rain = applyPhaseActions(server!.orm, t.gameId, [action(t.b, 'r1')], new ReplayRng([10, 10]), CLOCK, weatherTagging(assets, 1, 'SOLARION', { weather: 'Rain', disaster: false }));
    expect(rain.ok, JSON.stringify(!rain.ok && rain.errors)).toBe(true);
    expect(stamina(t.b)).toBe(before - 3 - 1);
  });

  it('C6: from day 5 Disaster holds whatever the AI picks: outdoor actions cost 2 more Stamina', async () => {
    const t = await table();
    for (const [day, phase] of [[5, 'EOSORIA'], [5, 'NOCTHERION'], [9, 'SOLARION']] as const) {
      expect((await server!.weather.ensure(t.gameId, { day, phase })).disaster).toBe(true);
    }
    expect((await server!.weather.ensure(t.gameId, { day: 4, phase: 'NOCTHERION' })).disaster).toBe(false);

    setPlace(t.gameId, 'ป่า');
    const before = stamina(t.a);
    const r = applyPhaseActions(server!.orm, t.gameId, [action(t.a, 'd1')], new ReplayRng([10, 10]), CLOCK, weatherTagging(assets, 5, 'SOLARION', { weather: 'Clear', disaster: true }));
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    expect(stamina(t.a)).toBe(before - 3 - 2);
  });

  it('C7: after a restart the current period keeps its weather and the AI is not asked again', async () => {
    const t = await table();
    const a = await enter(t.a);
    const first = (await a.waitFor(hasWeather)).weather;
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();

    const provider = scripted([]);
    server = await startTestServer(dataDir, { aiProvider: provider });
    const again = await enter(t.a);
    expect(again.lastRoom()!.weather).toEqual(first);
    await new Promise((r) => setTimeout(r, 100));
    expect(provider.requests).toHaveLength(0);
    expect(currentWeather(server.orm, t.gameId)).toMatchObject(first!);
  });
});
