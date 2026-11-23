import {
  ApiError,
  CreateGameResponse,
  defaultScenario,
  GameScenarioResponse,
  GameView,
  JoinResponse,
  type Scenario,
} from '@isekai/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';

const CREATE_CODE = 'ลับเฉพาะ-2026';
const MOCK_AI = loadAiConfig({ AI_PROVIDER: 'mock' });
const PHASE_ORDER = { EOSORIA: 0, SOLARION: 1, HESPERION: 2, NOCTHERION: 3 } as const;

/** Strings planted by the GM; none may reach a player's response. */
const CANARY_CONDITION = 'CANARY-เงื่อนไขลับ-ห้ามผู้เล่นเห็น';
const CANARY_EVENT = 'CANARY-event-ล่วงหน้า-วัน-4';
const CANARY_NPC = 'CANARY-โน้ตลับ-NPC';

/**
 * GEN-046 scenario of a game, ISK-017: the Human GM gives it once in the create form (POST /api/games `scenario`,
 * checked as the old editor did) and only reads it afterwards; PUT /api/game/scenario and the reset are gone (404).
 */
describe('scenario set at creation, read by the GM (GEN-046, ISK-017)', { timeout: 60_000 }, () => {
  let createCodeHash = '';
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const clock = Date.UTC(2026, 10, 22, 12, 0, 0);

  beforeAll(async () => {
    createCodeHash = await hashPin(CREATE_CODE);
  });

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash },
      { now: () => clock, ai: MOCK_AI, aiLog: () => {} },
    );
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

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

  const postGame = (humanGm: boolean, name: string, scenario?: unknown) =>
    call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'ห้องทดสอบ', mode: 'online', humanGm, name, pin: '1234', ...(scenario === undefined ? {} : { scenario }) },
    });

  async function createGame(humanGm: boolean, name = 'ต้น', scenario?: unknown) {
    const res = await postGame(humanGm, name, scenario);
    expect(res.status, res.text).toBe(200);
    return { ...CreateGameResponse.parse(res.body), raw: res.text };
  }

  async function join(inviteCode: string, name: string) {
    const res = await call('POST', '/api/join', { body: { inviteCode, name, pin: '1111' } });
    expect(res.status, res.text).toBe(200);
    return { ...JoinResponse.parse(res.body), raw: res.text };
  }

  /** A Human GM game (with `scenario`, or the default) and two players who joined. */
  async function gmGame(scenario?: unknown) {
    const gm = await createGame(true, 'ต้น', scenario);
    const nok = await join(gm.game.inviteCode, 'นก');
    const bel = await join(gm.game.inviteCode, 'เบล');
    return { gm, nok, bel };
  }

  async function getScenario(token: string) {
    const res = await call('GET', '/api/game/scenario', { token });
    expect(res.status, res.text).toBe(200);
    return GameScenarioResponse.parse(res.body);
  }

  const putScenario = (token: string, scenario: unknown) => call('PUT', '/api/game/scenario', { token, body: scenario });
  const resetScenario = (token: string) => call('POST', '/api/game/scenario/reset', { token });
  const error = (body: unknown) => ApiError.parse(body);
  const gameCount = () => (server!.db.prepare('select count(*) as n from game').get() as { n: number }).n;

  /** Characters are created by GEN-047; here a character row is seeded straight into the table. */
  function seedCharacter(memberId: string) {
    server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(memberId, clock);
    seedChosenLoot(server!.db, memberId);
  }

  async function startBy(...players: { token: string }[]) {
    for (const p of players) expect((await call('POST', '/api/game/ready', { token: p.token, body: { ready: true } })).status).toBe(200);
  }

  const newEvent = (patch: Record<string, unknown> = {}) => ({
    id: 'gm-day4-afternoon',
    day: 4,
    phase: 'SOLARION',
    title: 'ขบวนคาราวานมาถึงประตูเมือง',
    description: 'พ่อค้าต่างเมืองนำข่าวลือมาด้วย',
    outcome: 'ถ้าไม่มีใครช่วย คาราวานถูกปล้นตอนค่ำ',
    ...patch,
  });

  const isSorted = (s: Scenario) =>
    s.timeline.every((e, i) => {
      const prev = s.timeline[i - 1];
      return !prev || prev.day < e.day || (prev.day === e.day && PHASE_ORDER[prev.phase] <= PHASE_ORDER[e.phase]);
    });

  it('C1: the GM adds an event on day 4 afternoon at creation; it is stored and the timeline is sorted by day + phase', async () => {
    const base = defaultScenario();
    // Added at the end on purpose (after the day 12 finale), plus a morning event of the same day after it.
    const edited = {
      ...base,
      timeline: [...base.timeline, newEvent(), newEvent({ id: 'gm-day4-morning', phase: 'EOSORIA', title: 'เช้าวันที่ 4' })],
    };
    const { gm } = await gmGame(edited);
    const read = await getScenario(gm.token);
    expect(read.locked).toBe(false);
    const saved = read.scenario;

    expect(isSorted(saved)).toBe(true);
    const ids = saved.timeline.map((e) => e.id);
    expect(ids.indexOf('gm-day4-morning')).toBe(ids.indexOf('gm-day4-afternoon') - 1);
    const day4 = saved.timeline.find((e) => e.id === 'gm-day4-afternoon');
    expect(day4).toMatchObject({ day: 4, phase: 'SOLARION', outcome: 'ถ้าไม่มีใครช่วย คาราวานถูกปล้นตอนค่ำ' });
    // The day 1 event comes right before day 4 (GEN-071 has nothing on days 2-3), day 5 right after.
    expect(saved.timeline[ids.indexOf('gm-day4-morning') - 1]!.day).toBe(1);
    expect(saved.timeline[ids.indexOf('gm-day4-afternoon') + 1]!.day).toBe(5);
    expect(getGameScenario(server!.orm, gm.game.id)).toEqual(saved);
  });

  it('C1: the GM sets an event, a Legendary and an NPC at creation', async () => {
    const scenario = defaultScenario();
    const edited: Scenario = {
      ...scenario,
      timeline: scenario.timeline.map((e) => (e.day === 7 ? { ...e, title: 'เบาะแสใหม่ของ GM', outcome: 'ลัทธิย้ายฐาน' } : e)),
      legendaries: [{ ...scenario.legendaries[0]!, condition: 'ช่วยเด็กกำพร้าครบ 3 วันติด', target: 3 }],
      npcs: scenario.npcs.map((n) => (n.id === 'merchant' ? { ...n, alias: 'พ่อค้าเครายาว', gmNote: 'เป็นสายลับ' } : n)),
    };
    const { gm } = await gmGame(edited);
    const saved = (await getScenario(gm.token)).scenario;
    expect(saved.timeline.find((e) => e.day === 7)).toMatchObject({ title: 'เบาะแสใหม่ของ GM', outcome: 'ลัทธิย้ายฐาน' });
    expect(saved.legendaries).toEqual([expect.objectContaining({ condition: 'ช่วยเด็กกำพร้าครบ 3 วันติด', target: 3 })]);
    expect(saved.npcs.find((n) => n.id === 'merchant')).toMatchObject({ alias: 'พ่อค้าเครายาว', gmNote: 'เป็นสายลับ' });
  });

  it('C2: with a secret Legendary condition set at creation, no player-facing response has scenario content', async () => {
    const scenario = defaultScenario();
    const edited: Scenario = {
      ...scenario,
      legendaries: [{ ...scenario.legendaries[0]!, condition: CANARY_CONDITION }],
      timeline: [...scenario.timeline, { ...newEvent(), title: CANARY_EVENT } as Scenario['timeline'][number]],
      npcs: scenario.npcs.map((n, i) => (i === 0 ? { ...n, gmNote: CANARY_NPC } : n)),
    };
    const gm = await createGame(true, 'ต้น', edited);
    // The parsed copy (defaults filled in) is what the secrets come from.
    const saved = (await getScenario(gm.token)).scenario;
    expect(JSON.stringify(saved)).toContain(CANARY_EVENT);
    // The GM's own create answer does not echo it either.
    expect(gm.raw).not.toContain(CANARY_EVENT);

    // Everything a player can receive: join, me, the game view, a refused scenario read.
    const nok = await join(gm.game.inviteCode, 'นก');
    const bel = await join(gm.game.inviteCode, 'เบล');
    const responses = [nok.raw, bel.raw];
    for (const token of [nok.token, bel.token]) {
      responses.push((await call('GET', '/api/me', { token })).text);
      responses.push((await call('GET', '/api/game', { token })).text);
      const scenarioRead = await call('GET', '/api/game/scenario', { token });
      expect(scenarioRead.status).toBe(403);
      responses.push(scenarioRead.text);
    }
    // After the start too.
    seedCharacter(nok.member.id);
    seedCharacter(bel.member.id);
    await startBy(nok, bel);
    responses.push((await call('GET', '/api/game', { token: nok.token })).text);

    expectNoScenarioContent(responses, saved);
  });

  it('C2 / Q-028: a game without a Human GM never shows its creator-player the scenario', async () => {
    const creator = await createGame(false, 'นก');
    const bel = await join(creator.game.inviteCode, 'เบล');
    const responses = [creator.raw, bel.raw];
    for (const token of [creator.token, bel.token]) {
      responses.push((await call('GET', '/api/me', { token })).text);
      responses.push((await call('GET', '/api/game', { token })).text);
    }
    expectNoScenarioContent(responses, defaultScenario());
  });

  /** No scenario keys, no secret or future text (event, Legendary, NPC) in any of the bodies. */
  function expectNoScenarioContent(bodies: string[], scenario: Scenario) {
    const secrets = [
      ...scenario.timeline.flatMap((e) => [e.title, e.description, e.outcome, e.gmNote]),
      ...scenario.legendaries.flatMap((l) => [l.name, l.condition]),
      ...scenario.npcs.flatMap((n) => [n.name, n.alias, n.personality, n.gmNote]),
      ...scenario.locations.map((l) => l.gmNote),
    ].filter((s) => s.length > 0);
    expect(secrets).toContain(scenario.legendaries[0]!.condition);
    const keys = ['"timeline"', '"legendaries"', '"npcs"', '"gmNote"', '"condition"', '"origins"', '"scenario"'];
    for (const body of bodies) {
      for (const key of keys) expect(body, `${key} in ${body}`).not.toContain(key);
      for (const secret of secrets) expect(body, `"${secret}" leaked in ${body}`).not.toContain(secret);
    }
  }

  it('C2: the game view tells the client who may open the scenario: the GM before the start, nobody else', async () => {
    const { gm, nok } = await gmGame();
    expect(GameView.parse((await call('GET', '/api/game', { token: gm.token })).body).canEditScenario).toBe(true);
    expect(GameView.parse((await call('GET', '/api/game', { token: nok.token })).body).canEditScenario).toBe(false);

    const solo = await createGame(false, 'ปลา');
    expect(solo.game.canEditScenario).toBe(false);
  });

  it('C3 (ISK-017): nobody edits the scenario after creation: PUT and reset are 404 for the GM and players; it stays as it was', async () => {
    const { gm, nok } = await gmGame();
    const edited = { ...defaultScenario(), name: 'แอบแก้' };
    for (const token of [gm.token, nok.token]) {
      expect((await putScenario(token, edited)).status).toBe(404);
      expect((await resetScenario(token)).status).toBe(404);
    }
    expect((await call('GET', '/api/game/scenario', { token: nok.token })).status).toBe(403);
    expect((await getScenario(gm.token)).scenario).toEqual(defaultScenario());
  });

  it('Q-028: without a Human GM the scenario read refuses, even the creator', async () => {
    const creator = await createGame(false, 'นก');
    const read = await call('GET', '/api/game/scenario', { token: creator.token });
    expect(read.status).toBe(403);
    expect(error(read.body).message).toMatch(/GM/);
    expect(getGameScenario(server!.orm, creator.game.id)).toEqual(defaultScenario());
  });

  it('requests without a session get 401', async () => {
    expect((await call('GET', '/api/game/scenario')).status).toBe(401);
  });

  it('C4: a scenario without the day 12 finale is refused at creation; no game is made', async () => {
    const scenario = defaultScenario();
    const withoutFinale = { ...scenario, timeline: scenario.timeline.filter((e) => e.kind !== 'finale') };

    const res = await postGame(true, 'ต้น', withoutFinale);
    expect(res.status).toBe(400);
    const body = error(res.body);
    expect(body.code).toBe('invalid_input');
    if (body.code !== 'invalid_input') return;
    expect(body.fields).toEqual({ timeline: expect.stringMatching(/ฉากจบ.*12/) });
    expect(gameCount()).toBe(0);
  });

  it('C5: day 13, an empty title or a wrong phase is refused at creation and names the field', async () => {
    const scenario = defaultScenario();
    const at = scenario.timeline.length;
    const bad = { ...scenario, timeline: [...scenario.timeline, newEvent({ day: 13, title: '   ', phase: 'EVENING' })] };

    const res = await postGame(true, 'ต้น', bad);
    expect(res.status).toBe(400);
    const body = error(res.body);
    if (body.code !== 'invalid_input') throw new Error(JSON.stringify(body));
    expect(Object.keys(body.fields).sort()).toEqual([`timeline.${at}.day`, `timeline.${at}.phase`, `timeline.${at}.title`]);
    expect(body.fields[`timeline.${at}.day`]).toMatch(/1 ถึง 12/);
    expect(body.fields[`timeline.${at}.title`]).toMatch(/ห้ามว่าง/);
    expect(body.fields[`timeline.${at}.phase`]).toMatch(/เช้า.*บ่าย.*ค่ำ/);

    // Not a scenario at all.
    expect((await postGame(true, 'ต้น', { hello: 1 })).status).toBe(400);
    expect(gameCount()).toBe(0);
  });

  it('C6: after the start the GM can still read the scenario (locked)', async () => {
    const { gm, nok, bel } = await gmGame();
    seedCharacter(nok.member.id);
    seedCharacter(bel.member.id);
    await startBy(nok, bel);

    const read = await getScenario(gm.token);
    expect(read.locked).toBe(true);
    expect(read.scenario).toEqual(defaultScenario());
    expect(GameView.parse((await call('GET', '/api/game', { token: gm.token })).body).canEditScenario).toBe(false);
  });

  it('C7: each game keeps the scenario it was created with; no scenario = the default template', async () => {
    const { gm } = await gmGame({ ...defaultScenario(), name: 'ของ GM', timeline: [...defaultScenario().timeline, newEvent()] });
    const other = await createGame(true, 'ปลา', { ...defaultScenario(), name: 'เกมอื่น' });
    const plain = await createGame(true, 'ฟ้า');
    expect((await getScenario(gm.token)).scenario.name).toBe('ของ GM');
    expect((await getScenario(other.token)).scenario.name).toBe('เกมอื่น');
    expect((await getScenario(plain.token)).scenario).toEqual(defaultScenario());
  });
});
