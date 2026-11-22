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

describe('scenario editor before the start (GEN-046)', { timeout: 60_000 }, () => {
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

  async function createGame(humanGm: boolean, name = 'ต้น') {
    const res = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'ห้องทดสอบ', mode: 'online', humanGm, name, pin: '1234' },
    });
    expect(res.status, res.text).toBe(200);
    return { ...CreateGameResponse.parse(res.body), raw: res.text };
  }

  async function join(inviteCode: string, name: string) {
    const res = await call('POST', '/api/join', { body: { inviteCode, name, pin: '1111' } });
    expect(res.status, res.text).toBe(200);
    return { ...JoinResponse.parse(res.body), raw: res.text };
  }

  /** A Human GM game with two players who joined. */
  async function gmGame() {
    const gm = await createGame(true);
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

  /** Characters are created by GEN-047; here a character row is seeded straight into the table. */
  function seedCharacter(memberId: string) {
    server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(memberId, clock);
    seedChosenLoot(server!.db, memberId);
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

  it('C1: the GM adds an event on day 4 afternoon; it is saved and the timeline is sorted by day + phase', async () => {
    const { gm } = await gmGame();
    const before = await getScenario(gm.token);
    expect(before).toMatchObject({ locked: false });
    expect(before.scenario).toEqual(defaultScenario());

    // Added at the end on purpose (after the day 12 finale), plus a morning event of the same day after it.
    const edited = {
      ...before.scenario,
      timeline: [...before.scenario.timeline, newEvent(), newEvent({ id: 'gm-day4-morning', phase: 'EOSORIA', title: 'เช้าวันที่ 4' })],
    };
    const res = await putScenario(gm.token, edited);
    expect(res.status, res.text).toBe(200);
    const saved = GameScenarioResponse.parse(res.body).scenario;

    expect(isSorted(saved)).toBe(true);
    const ids = saved.timeline.map((e) => e.id);
    expect(ids.indexOf('gm-day4-morning')).toBe(ids.indexOf('gm-day4-afternoon') - 1);
    const day4 = saved.timeline.find((e) => e.id === 'gm-day4-afternoon');
    expect(day4).toMatchObject({ day: 4, phase: 'SOLARION', outcome: 'ถ้าไม่มีใครช่วย คาราวานถูกปล้นตอนค่ำ' });
    // Day 3 events come right before day 4, day 5 right after.
    expect(saved.timeline[ids.indexOf('gm-day4-morning') - 1]!.day).toBe(3);
    expect(saved.timeline[ids.indexOf('gm-day4-afternoon') + 1]!.day).toBe(5);

    // Stored, not only echoed.
    expect((await getScenario(gm.token)).scenario).toEqual(saved);
    expect(getGameScenario(server!.orm, gm.game.id)).toEqual(saved);
  });

  it('C1: the GM edits an event, a Legendary and an NPC', async () => {
    const { gm } = await gmGame();
    const { scenario } = await getScenario(gm.token);
    const edited: Scenario = {
      ...scenario,
      timeline: scenario.timeline.map((e) => (e.day === 3 ? { ...e, title: 'เบาะแสใหม่ของ GM', outcome: 'ลัทธิย้ายฐาน' } : e)),
      legendaries: [{ ...scenario.legendaries[0]!, condition: 'ช่วยเด็กกำพร้าครบ 3 วันติด', target: 3 }],
      npcs: scenario.npcs.map((n) => (n.id === 'merchant' ? { ...n, alias: 'พ่อค้าเครายาว', gmNote: 'เป็นสายลับ' } : n)),
    };
    const res = await putScenario(gm.token, edited);
    expect(res.status, res.text).toBe(200);
    const saved = (await getScenario(gm.token)).scenario;
    expect(saved.timeline.find((e) => e.day === 3)).toMatchObject({ title: 'เบาะแสใหม่ของ GM', outcome: 'ลัทธิย้ายฐาน' });
    expect(saved.legendaries).toEqual([expect.objectContaining({ condition: 'ช่วยเด็กกำพร้าครบ 3 วันติด', target: 3 })]);
    expect(saved.npcs.find((n) => n.id === 'merchant')).toMatchObject({ alias: 'พ่อค้าเครายาว', gmNote: 'เป็นสายลับ' });
  });

  it('C2: after the GM edits the Legendary condition, no player-facing response has scenario content', async () => {
    const gm = await createGame(true);
    const { scenario } = await getScenario(gm.token);
    const edited: Scenario = {
      ...scenario,
      legendaries: [{ ...scenario.legendaries[0]!, condition: CANARY_CONDITION }],
      timeline: [...scenario.timeline, { ...newEvent(), title: CANARY_EVENT } as Scenario['timeline'][number]],
      npcs: scenario.npcs.map((n, i) => (i === 0 ? { ...n, gmNote: CANARY_NPC } : n)),
    };
    const put = await putScenario(gm.token, edited);
    expect(put.status).toBe(200);
    // The parsed copy (defaults filled in) is what the secrets come from.
    const saved = GameScenarioResponse.parse(put.body).scenario;
    expect(JSON.stringify(saved)).toContain(CANARY_EVENT);

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
    expect((await call('POST', '/api/game/start', { token: gm.token })).status).toBe(200);
    responses.push((await call('GET', '/api/game', { token: nok.token })).text);

    expectNoScenarioContent(responses, saved);
  });

  it('C2 / Q-028: a game without a Human GM never shows its owner-player the scenario', async () => {
    const owner = await createGame(false, 'นก');
    const bel = await join(owner.game.inviteCode, 'เบล');
    const responses = [owner.raw, bel.raw];
    for (const token of [owner.token, bel.token]) {
      responses.push((await call('GET', '/api/me', { token })).text);
      responses.push((await call('GET', '/api/game', { token })).text);
    }
    responses.push((await call('POST', '/api/game/invite-code', { token: owner.token })).text);
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

  it('C2: the game view tells the client who may edit: the GM before the start, nobody else', async () => {
    const { gm, nok } = await gmGame();
    expect(GameView.parse((await call('GET', '/api/game', { token: gm.token })).body).canEditScenario).toBe(true);
    expect(GameView.parse((await call('GET', '/api/game', { token: nok.token })).body).canEditScenario).toBe(false);

    const solo = await createGame(false, 'ปลา');
    expect(solo.game.canEditScenario).toBe(false);
  });

  it('C3: a player who edits the scenario gets 403, and the scenario stays as it was', async () => {
    const { gm, nok } = await gmGame();
    const edited = { ...defaultScenario(), name: 'ผู้เล่นแอบแก้' };

    const res = await putScenario(nok.token, edited);
    expect(res.status).toBe(403);
    expect(error(res.body)).toMatchObject({ code: 'forbidden' });
    expect((await resetScenario(nok.token)).status).toBe(403);
    expect((await call('GET', '/api/game/scenario', { token: nok.token })).status).toBe(403);
    expect((await getScenario(gm.token)).scenario).toEqual(defaultScenario());
  });

  it('Q-028: without a Human GM every scenario endpoint refuses, even the owner', async () => {
    const owner = await createGame(false, 'นก');
    expect((await call('GET', '/api/game/scenario', { token: owner.token })).status).toBe(403);
    const put = await putScenario(owner.token, { ...defaultScenario(), name: 'เจ้าของแอบแก้' });
    expect(put.status).toBe(403);
    expect(error(put.body).message).toMatch(/GM/);
    expect((await resetScenario(owner.token)).status).toBe(403);
    expect(getGameScenario(server!.orm, owner.game.id)).toEqual(defaultScenario());
  });

  it('requests without a session get 401', async () => {
    expect((await call('GET', '/api/game/scenario')).status).toBe(401);
    expect((await putScenario('nope', defaultScenario())).status).toBe(401);
    expect((await resetScenario('nope')).status).toBe(401);
  });

  it('C4: the GM cannot delete the day 12 finale', async () => {
    const { gm } = await gmGame();
    const { scenario } = await getScenario(gm.token);
    const withoutFinale = { ...scenario, timeline: scenario.timeline.filter((e) => e.kind !== 'finale') };

    const res = await putScenario(gm.token, withoutFinale);
    expect(res.status).toBe(400);
    const body = error(res.body);
    expect(body.code).toBe('invalid_input');
    if (body.code !== 'invalid_input') return;
    expect(body.fields).toEqual({ timeline: expect.stringMatching(/ฉากจบ.*12/) });
    expect((await getScenario(gm.token)).scenario).toEqual(defaultScenario());
  });

  it('C5: day 13, an empty title or a wrong phase is refused and names the field', async () => {
    const { gm } = await gmGame();
    const { scenario } = await getScenario(gm.token);
    const at = scenario.timeline.length;
    const bad = { ...scenario, timeline: [...scenario.timeline, newEvent({ day: 13, title: '   ', phase: 'EVENING' })] };

    const res = await putScenario(gm.token, bad);
    expect(res.status).toBe(400);
    const body = error(res.body);
    if (body.code !== 'invalid_input') throw new Error(JSON.stringify(body));
    expect(Object.keys(body.fields).sort()).toEqual([`timeline.${at}.day`, `timeline.${at}.phase`, `timeline.${at}.title`]);
    expect(body.fields[`timeline.${at}.day`]).toMatch(/1 ถึง 12/);
    expect(body.fields[`timeline.${at}.title`]).toMatch(/ห้ามว่าง/);
    expect(body.fields[`timeline.${at}.phase`]).toMatch(/เช้า.*บ่าย.*ค่ำ/);
    expect((await getScenario(gm.token)).scenario).toEqual(defaultScenario());

    // Not a scenario at all.
    const garbage = await putScenario(gm.token, { hello: 1 });
    expect(garbage.status).toBe(400);
  });

  it('C6: after the start the editor cannot save or reset; the GM can still read it (locked)', async () => {
    const { gm, nok, bel } = await gmGame();
    seedCharacter(nok.member.id);
    seedCharacter(bel.member.id);
    expect((await call('POST', '/api/game/start', { token: gm.token })).status).toBe(200);

    const read = await getScenario(gm.token);
    expect(read.locked).toBe(true);
    const res = await putScenario(gm.token, { ...read.scenario, name: 'แก้หลังเริ่ม' });
    expect(res.status).toBe(409);
    expect(error(res.body)).toMatchObject({ code: 'game_started' });
    expect((await resetScenario(gm.token)).status).toBe(409);
    expect((await getScenario(gm.token)).scenario).toEqual(defaultScenario());
    expect(GameView.parse((await call('GET', '/api/game', { token: gm.token })).body).canEditScenario).toBe(false);
  });

  it('C7: "คืนค่า default" puts the copy back to the default template; other games are untouched', async () => {
    const { gm } = await gmGame();
    const other = await createGame(true, 'ปลา');
    const { scenario } = await getScenario(gm.token);
    const edited = { ...scenario, name: 'ของ GM', timeline: [...scenario.timeline, newEvent()] };
    expect((await putScenario(gm.token, edited)).status).toBe(200);
    expect((await putScenario(other.token, { ...scenario, name: 'เกมอื่น' })).status).toBe(200);

    const res = await resetScenario(gm.token);
    expect(res.status, res.text).toBe(200);
    expect(GameScenarioResponse.parse(res.body).scenario).toEqual(defaultScenario());
    expect((await getScenario(gm.token)).scenario).toEqual(defaultScenario());
    expect((await getScenario(other.token)).scenario.name).toBe('เกมอื่น');
  });
});
