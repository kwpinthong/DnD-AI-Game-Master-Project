import {
  CreateGameResponse,
  defaultScenario,
  GameScenarioResponse,
  parseScenario,
  PHASES,
  type Phase,
  type Scenario,
} from '@isekai/protocol';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { createAiService } from '../src/ai/core/service.ts';
import { createUsageStore } from '../src/ai/core/usage.ts';
import { createMockProvider } from '../src/ai/providers/mock.ts';
import { loadGameAssets, type GameAssets } from '../src/assets/load.ts';
import { openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import { game } from '../src/db/schema.ts';
import { copyTemplateForGame, getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { buildEventContext, foreshadowingFor } from '../src/timeline/context.ts';
import { advanceTimeline, getEventOutcomes, getTimeline } from '../src/timeline/store.ts';
import { startPhaseEvents } from '../src/timeline/trigger.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CREATE_CODE, startTestServer } from './visibility-fixture.ts';

/** GEN-071: the default scenario comes from the sheet (World_Timeline 5 events, NPC roster, Location names). */

const GAME = 'game-a';
const MOCK_AI = loadAiConfig({ AI_PROVIDER: 'mock' });
const assets = loadGameAssets();
const OLD_DEFAULT = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scenario-gen045-default.json'), 'utf8'),
) as unknown;

/** "เช้าวันที่ 4: ..." → day 4 EOSORIA (the sheet's Foreshadowing_Trigger); anything else = no trigger. */
function sheetTrigger(text: string): { day: number; phase: Phase } | null {
  const m = /^เช้าวันที่ (\d+)/.exec(text);
  return m ? { day: Number(m[1]), phase: 'EOSORIA' } : null;
}

describe('GEN-071 default scenario from the sheet', () => {
  let opened: OpenedDatabase;
  let cleanup = () => {};

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

  const statusOf = (eventId: string) => getTimeline(opened.db, GAME)!.events.find((e) => e.id === eventId)!;
  const aiWith = (mock: ReturnType<typeof createMockProvider>) =>
    createAiService({ provider: mock, config: MOCK_AI, usage: createUsageStore(opened.db), log: () => {} });

  it('C1: the timeline is the 5 World_Timeline rows, in order, and day 12 is the finale', () => {
    const scenario = defaultScenario();
    expect(assets.worldTimeline).toHaveLength(5);
    expect(scenario.timeline).toHaveLength(assets.worldTimeline.length);
    const places = new Map(scenario.locations.map((l) => [l.id, l.name]));
    scenario.timeline.forEach((event, i) => {
      const row = assets.worldTimeline[i]!;
      expect(event.day).toBe(row.day);
      expect(event.phase).toBe(row.periods[0]);
      expect(event.endPhase).toBe(row.periods.length > 1 ? row.periods.at(-1) : null);
      expect(event.title).toBe(row.name);
      expect(event.interventionEffects).toBe(row.interventionEffects);
      expect(event.outcome).toBe(row.driftIfIgnored);
      expect(event.foreshadowing).toBe(row.foreshadowing);
      expect(event.foreshadowAt).toEqual(sheetTrigger(row.foreshadowing));
      for (const id of event.locationIds ?? []) expect(row.location).toContain(places.get(id));
    });
    expect(scenario.timeline.map((e) => e.day)).toEqual([1, 5, 7, 10, 12]);
    expect(scenario.timeline.filter((e) => e.kind === 'finale').map((e) => e.day)).toEqual([12]);
    expect(scenario.timeline.at(-1)).toMatchObject({ day: 12, phase: 'HESPERION', endPhase: 'NOCTHERION', kind: 'finale' });
  });

  it('GEN-097 C6: an event at places gets every sheet Location its World_Timeline Location names, in sheet order', () => {
    const scenario = defaultScenario();
    const idOf = new Map(scenario.locations.map((l) => [l.name, l.id]));
    /** "A & B" / "A / B" → the ids of the parts that are Location names (the scenario's name → id). */
    const sheetPlaces = (text: string) => text.split(/\s*[&/]\s*/).flatMap((name) => (idOf.has(name) ? [idOf.get(name)!] : []));
    scenario.timeline.forEach((event, i) => {
      if (event.locationIds !== null) expect(event.locationIds, event.id).toEqual(sheetPlaces(assets.worldTimeline[i]!.location));
    });
    const byDay = new Map(scenario.timeline.map((e) => [e.day, e.locationIds]));
    expect(byDay.get(10)).toEqual(sheetPlaces(assets.worldTimeline.find((r) => r.day === 10)!.location));
    expect(byDay.get(10)).toHaveLength(2);
    expect(byDay.get(7)).toEqual(sheetPlaces(assets.worldTimeline.find((r) => r.day === 7)!.location));
    // Town-wide (Q-080): the disaster of day 5 and the finale.
    expect(byDay.get(5)).toBeNull();
    expect(byDay.get(12)).toBeNull();
  });

  it('C1 / Q-129: every place of the default scenario is a sheet Location, by name', () => {
    for (const place of defaultScenario().locations) expect(assets.location(place.name), place.name).toBeDefined();
  });

  it('Q-161: connections, safety and rest quality of every place come from the sheet Location row', () => {
    const scenario = defaultScenario();
    const idOf = new Map(scenario.locations.map((l) => [l.name, l.id]));
    for (const place of scenario.locations) {
      const row = assets.location(place.name)!;
      expect(place.connects, place.name).toEqual(row.connectsTo.map((name) => idOf.get(name)));
      expect(place.safety, place.name).toBe(row.safety!.toLowerCase());
      expect(place.restQuality, place.name).toBe(row.restQuality);
    }
    // The special links (Q-161).
    const byId = new Map(scenario.locations.map((l) => [l.id, l]));
    expect(byId.get('temple')!.connects).toContain('church-crypt');
    expect(byId.get('church-crypt')!.connects).toEqual(['temple']);
    expect(byId.get('library')!.connects).toContain('astral-rift');
    expect(byId.get('astral-rift')!.connects).toEqual(['library']);
  });

  it('Q-161: an NPC with a Public_Alias in the sheet goes by it', () => {
    const npcs = defaultScenario().npcs;
    for (const record of assets.npcs) {
      const npc = npcs.find((n) => assets.npc(n.name) === record)!;
      if (record.publicAlias !== '') expect(npc.alias, record.name).toBe(record.publicAlias);
    }
    expect(npcs.find((n) => n.id === 'noble')!.alias).toBe('ขุนนางผู้มาเยือน');
  });

  it('Q-220: grade F / A aliases are the sheet Public_Alias word for word; grade S goes by its Public_Alias too (Q-219)', () => {
    const aliases = Object.fromEntries(defaultScenario().npcs.filter((n) => n.rank !== 'B').map((n) => [n.id, n.alias]));
    expect(aliases).toEqual({
      beggar: 'เด็กขอทานตาบอดข้างหนึ่ง',
      amnesiac: 'หญิงสาวผู้พกนาฬิกาพกตาย',
      noble: 'ขุนนางผู้มาเยือน',
      archbishop: 'นักบวชผู้ใจบุญประจำเมือง',
      archivist: 'สตรีผู้ดูแลหอจดหมายเหตุ',
      'light-spirit': 'ภูตแห่งแสงในแท่นบูชา',
      'dark-spirit': 'เงาในรอยแยกใต้แท่นพิธี',
      'horizon-watcher': 'ผู้เฝ้ามองเส้นขอบฟ้า',
    });
    for (const n of defaultScenario().npcs) expect(n.alias, n.id).toBe(assets.npc(n.name)!.publicAlias);
  });

  it('C1: the finale lasts both of its periods (4 turns) and resolves only at the end of the game', () => {
    advanceTimeline(opened.db, GAME, { day: 12, phase: 'HESPERION' });
    expect(statusOf('d12-meteor').status).toBe('active');
    advanceTimeline(opened.db, GAME, { day: 12, phase: 'NOCTHERION' });
    expect(statusOf('d12-meteor').status).toBe('active');
    expect(buildEventContext(opened.db, GAME, 12, 'NOCTHERION').active.map((e) => e.id)).toEqual(['d12-meteor']);
    advanceTimeline(opened.db, GAME, 'end');
    expect(statusOf('d12-meteor')).toMatchObject({ status: 'resolved', outcomeSource: 'default' });
  });

  it('C2: the next event\'s foreshadowing is in the AI context on the mornings of days 4, 6, 9, 11 only', async () => {
    const scenario = defaultScenario();
    const triggered = scenario.timeline.filter((e) => e.foreshadowAt !== null);
    expect(triggered.map((e) => e.foreshadowAt)).toEqual([4, 6, 9, 11].map((day) => ({ day, phase: 'EOSORIA' })));
    const mock = createMockProvider(MOCK_AI);
    const ai = aiWith(mock);
    for (let day = 1; day <= 12; day++) {
      for (const phase of PHASES) {
        await startPhaseEvents({ db: opened.db, ai, assets }, GAME, { day, phase });
        const prompt = mock.requests.at(-1)!.system.map((b) => b.text).join('\n');
        for (const event of scenario.timeline) {
          const due = event.foreshadowAt?.day === day && event.foreshadowAt.phase === phase;
          expect(prompt.includes(event.foreshadowing), `${event.id} on day ${day} ${phase}`).toBe(due);
        }
      }
    }
    expect(foreshadowingFor(scenario, 4, 'EOSORIA')).toEqual([{ eventId: 'd5-disaster', text: triggered[0]!.foreshadowing }]);
    expect(foreshadowingFor(scenario, 4, 'SOLARION')).toEqual([]);
    expect(foreshadowingFor(scenario, 3, 'EOSORIA')).toEqual([]);
  });

  it('C3: day 5 ends with nobody stepping in: resolved as ignored with the drift (forest / coast closed) recorded', () => {
    const drift = assets.worldTimeline.find((r) => r.day === 5)!.driftIfIgnored;
    advanceTimeline(opened.db, GAME, { day: 5, phase: 'EOSORIA' });
    expect(statusOf('d5-disaster').status).toBe('active');
    advanceTimeline(opened.db, GAME, { day: 5, phase: 'SOLARION' });
    expect(statusOf('d5-disaster')).toMatchObject({ status: 'resolved', outcome: drift, outcomeSource: 'default' });
    expect(drift).toContain('ป่า');
    expect(drift).toContain('ชายฝั่ง');
    expect(getEventOutcomes(opened.db, GAME).find((o) => o.eventId === 'd5-disaster')).toMatchObject({ outcome: drift, intervened: false });
  });

  it('C4: the starting roster is the sheet NPC tab by grade, with no SS', () => {
    const npcs = defaultScenario().npcs;
    expect(npcs).toHaveLength(assets.npcs.length);
    for (const record of assets.npcs) {
      const matches = npcs.filter((n) => assets.npc(n.name) === record);
      expect(matches, record.name).toHaveLength(1);
      expect(matches[0]!.rank).toBe(record.grade);
    }
    expect(npcs.some((n) => (n.rank as string) === 'SS')).toBe(false);
    const counts = Object.fromEntries(['F', 'B', 'A', 'S'].map((g) => [g, npcs.filter((n) => n.rank === g).length]));
    expect(counts).toEqual(Object.fromEntries(['F', 'B', 'A', 'S'].map((g) => [g, assets.npcs.filter((n) => n.grade === g).length])));
    const ss = { ...defaultScenario(), npcs: npcs.map((n, i) => (i === 0 ? { ...n, rank: 'SS' } : n)) };
    expect(parseScenario(ss)).toMatchObject({ ok: false, errors: [{ path: 'npcs.0.rank', message: expect.stringMatching(/วิวัฒนาการ/) }] });
  });

  it('C6: a game stored with the previous default scenario still loads and plays its own events', () => {
    const parsed = parseScenario(OLD_DEFAULT);
    expect(parsed.ok).toBe(true);
    expect(updateGameScenario(opened.db, GAME, OLD_DEFAULT).ok).toBe(true);
    const scenario = getGameScenario(opened.db, GAME)!;
    expect(scenario.timeline.map((e) => e.id)).toEqual((OLD_DEFAULT as Scenario).timeline.map((e) => e.id));
    expect(scenario.timeline.every((e) => e.endPhase === null && e.foreshadowAt === null && e.strategyIds.length === 0)).toBe(true);
    advanceTimeline(opened.db, GAME, { day: 3, phase: 'HESPERION' });
    expect(buildEventContext(opened.db, GAME, 3, 'HESPERION', assets).active.map((e) => e.id)).toEqual(['d3-cult-clue']);
    expect(statusOf('d2-first-companion').status).toBe('resolved');
  });

  it('C7: the day 10 event lists the Day10_Strategies it names; missing strategies fall back to drift without error', () => {
    const scenario = getGameScenario(opened.db, GAME)!;
    const day10 = scenario.timeline.find((e) => e.day === 10)!;
    expect(day10.strategyIds).toEqual(['D10-S1', 'D10-S2', 'D10-S3', 'D10-S4']);
    const drift = assets.worldTimeline.find((r) => r.day === 10)!.driftIfIgnored;
    advanceTimeline(opened.db, GAME, { day: 10, phase: 'NOCTHERION' });

    const withSheet = buildEventContext(opened.db, GAME, 10, 'NOCTHERION', assets).active[0]!;
    expect(withSheet.strategies.map((s) => s.id)).toEqual(['D10-S1', 'D10-S2', 'D10-S3', 'D10-S4']);
    expect(withSheet.defaultOutcome).toBe(drift);

    const { day10Strategies: _gone, ...noTab } = assets;
    const withoutTab = buildEventContext(opened.db, GAME, 10, 'NOCTHERION', noTab as GameAssets).active[0]!;
    expect(withoutTab).toMatchObject({ id: day10.id, strategies: [], defaultOutcome: drift });

    scenario.timeline = scenario.timeline.map((e) => (e.id === day10.id ? { ...e, strategyIds: ['D10-S1', 'D10-S9'] } : e));
    expect(updateGameScenario(opened.db, GAME, scenario).ok).toBe(true);
    expect(buildEventContext(opened.db, GAME, 10, 'NOCTHERION', assets).active[0]!.strategies.map((s) => s.id)).toEqual(['D10-S1']);

    advanceTimeline(opened.db, GAME, { day: 11, phase: 'EOSORIA' });
    expect(statusOf(day10.id)).toMatchObject({ status: 'resolved', outcome: drift, outcomeSource: 'default' });
  });
});

describe('GEN-071 scenario editor and old games over HTTP', { timeout: 60_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(async () => {
    const temp = makeTempDir();
    cleanup = temp.cleanup;
    server = await startTestServer(temp.dir);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  // ISK-017: the scenario is given in the create form; the GM only reads it afterwards.
  const postGame = (scenario?: unknown) =>
    caller(server!)('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'ห้องทดสอบ', mode: 'online', humanGm: true, name: 'จีเอ็ม', pin: '1234', ...(scenario === undefined ? {} : { scenario }) },
    });

  async function gmGame(scenario?: unknown) {
    const call = caller(server!);
    const res = await postGame(scenario);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const created = CreateGameResponse.parse(res.body);
    return { call, token: created.token, gameId: created.game.id };
  }

  it('C1 / C5: a new game\'s GM sees the 5 sheet events by period range; a game created with another range keeps it', async () => {
    const { call, token } = await gmGame();
    const got = GameScenarioResponse.parse((await call('GET', '/api/game/scenario', { token })).body).scenario;
    expect(got.timeline.map((e) => [e.day, e.phase, e.endPhase])).toEqual([
      [1, 'EOSORIA', null],
      [5, 'EOSORIA', null],
      [7, 'HESPERION', null],
      [10, 'NOCTHERION', null],
      [12, 'HESPERION', 'NOCTHERION'],
    ]);
    const edited = { ...got, timeline: got.timeline.map((e) => (e.day === 7 ? { ...e, endPhase: 'NOCTHERION' as const } : e)) };
    const other = await gmGame(edited);
    const read = GameScenarioResponse.parse((await call('GET', '/api/game/scenario', { token: other.token })).body).scenario;
    expect(read.timeline.find((e) => e.day === 7)!.endPhase).toBe('NOCTHERION');
  });

  it('C5: a period that does not exist, or a range that ends before it starts, is refused naming the field', async () => {
    const { call, token } = await gmGame();
    const got = GameScenarioResponse.parse((await call('GET', '/api/game/scenario', { token })).body).scenario;
    const at = got.timeline.findIndex((e) => e.day === 7);
    const withAt = (patch: Record<string, unknown>) => ({ ...got, timeline: got.timeline.map((e, i) => (i === at ? { ...e, ...patch } : e)) });

    const unknown = await postGame(withAt({ endPhase: 'EVENING' }));
    expect(unknown.status).toBe(400);
    expect((unknown.body as { fields: Record<string, string> }).fields).toEqual({ [`timeline.${at}.endPhase`]: expect.stringMatching(/เช้า.*บ่าย.*ค่ำ/) });

    const backwards = await postGame(withAt({ endPhase: 'SOLARION' }));
    expect(backwards.status).toBe(400);
    expect((backwards.body as { fields: Record<string, string> }).fields).toEqual({ [`timeline.${at}.endPhase`]: expect.stringMatching(/ก่อนช่วงเริ่ม/) });

    const lateHint = await postGame(withAt({ foreshadowAt: { day: 8, phase: 'EOSORIA' } }));
    expect(lateHint.status).toBe(400);
    expect((lateHint.body as { fields: Record<string, string> }).fields).toEqual({ [`timeline.${at}.foreshadowAt`]: expect.stringMatching(/ก่อนเหตุการณ์/) });
  });

  it('C6: a game whose stored copy is the previous default scenario still opens in the editor', async () => {
    const { call, token, gameId } = await gmGame();
    server!.db.prepare('update game_scenario set data = ? where game_id = ?').run(JSON.stringify(OLD_DEFAULT), gameId);
    const res = await call('GET', '/api/game/scenario', { token });
    expect(res.status).toBe(200);
    const scenario = GameScenarioResponse.parse(res.body).scenario;
    expect(scenario.timeline.map((e) => e.id)).toEqual((OLD_DEFAULT as Scenario).timeline.map((e) => e.id));
    expect(scenario.npcs.map((n) => n.id)).toEqual((OLD_DEFAULT as Scenario).npcs.map((n) => n.id));
  });
});
