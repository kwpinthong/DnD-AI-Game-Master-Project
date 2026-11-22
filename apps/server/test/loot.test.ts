import { ApiError, CreateGameResponse, JoinResponse, LOOT_SCOPES, LootResponse, type LootView } from '@isekai/protocol';
import { STATUS_SCOPES } from '@isekai/rules';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { createMockProvider, mockReply, type MockProvider } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import { LOOT_AI_FAILED } from '../src/game/loot.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

const CREATE_CODE = 'ลับเฉพาะ-2026';

/** The personality names the character, so the prompt check (Q-045) has something to catch. */
const lin = {
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง',
  personality: 'ลินเป็นคนช่างสังเกต พูดน้อย ขี้ระแวง กลัวความมืด',
};
const OWNER_NAME = 'นกฮูก';

type Option = Record<string, unknown>;
const qual = (name: string, patch: Option = {}): Option => ({
  name,
  description: `${name}: ใช้ได้เมื่อเรื่องเปิดโอกาส`,
  tier: 'Common',
  buffType: 'Qualitative',
  ...patch,
});
const quant = (name: string, effect: Option, patch: Option = {}): Option =>
  qual(name, { buffType: 'Quantitative', effect, ...patch });

/** What the AI answers for `character_analyze`: traits + 3 skills + 3 items, all valid. */
function analysis(prefix = '', patch: Record<string, unknown> = {}) {
  return {
    strength: { label: `${prefix}ช่างสังเกต`, scope: 'observe', description: 'มองเห็นรายละเอียดที่คนอื่นพลาด' },
    weakness: { label: `${prefix}กลัวความมืด`, scope: 'stealth', description: 'ในที่มืดใจสั่น' },
    skills: [
      qual(`${prefix}อ่านสีหน้า`),
      quant(`${prefix}สายตาเหยี่ยว`, { type: 'check_bonus', scope: 'perception', value: 2 }),
      qual(`${prefix}เงียบงัน`),
    ],
    items: [
      quant(`${prefix}เสื้อหนังเก่า`, { type: 'damage_reduction', value: 2 }),
      qual(`${prefix}สมุดจดลับ`),
      quant(`${prefix}ยาบำรุงกำลัง`, { type: 'stamina_refund', value: 1 }),
    ],
    ...patch,
  };
}

type Step = AiCallResult | ((req: AiCallRequest) => AiCallResult);

describe('personality-driven loot: AI offers Common skills / items (GEN-048)', { timeout: 60_000 }, () => {
  let createCodeHash = '';
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let mock: MockProvider;
  let aiReady = true;
  const clock = Date.UTC(2026, 10, 22, 12, 0, 0);

  beforeAll(async () => {
    createCodeHash = await hashPin(CREATE_CODE);
  });

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    aiReady = true;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** A server whose AI answers `steps` in order (AI_MAX_RETRIES=0: one attempt per AI request). */
  async function start(steps: Step[]) {
    const config = loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0' });
    mock = createMockProvider(config, { steps });
    const provider: AiProvider = {
      id: mock.id,
      ready: () => (aiReady ? { ok: true } : { ok: false, reason: 'ยังไม่ได้ตั้งค่า AI' }),
      call: (req) => mock.call(req),
      estimateTokens: (text) => mock.estimateTokens(text),
    };
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash },
      { now: () => clock, ai: config, aiProvider: provider, aiLog: () => {} },
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
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as unknown };
  }

  async function createGame(patch: Record<string, unknown> = {}) {
    const res = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, name: OWNER_NAME, pin: '1234', ...patch },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CreateGameResponse.parse(res.body);
  }

  /** A game whose owner already has the character `lin`. */
  async function playerWithCharacter() {
    const created = await createGame();
    const res = await call('POST', '/api/game/character', { token: created.token, body: lin });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return created;
  }

  const rollLoot = (token: string) => call('POST', '/api/game/character/loot', { token });
  const getLoot = (token: string) => call('GET', '/api/game/character/loot', { token });
  const choose = (token: string, body: unknown) => call('POST', '/api/game/character/loot/choose', { token, body });

  function lootOf(res: { status: number; body: unknown }, status = 200): LootView {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return LootResponse.parse(res.body).loot;
  }

  const lootRow = (memberId: string) =>
    server!.db.prepare('select * from character_loot where member_id = ?').get(memberId) as Record<string, unknown> | undefined;

  it('C1: Mock gives 3 skills + 3 items; picking one of each saves them as Common with their buffType', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    const offered = lootOf(await rollLoot(me.token));

    const offer = offered.offer!;
    expect(offer.strength).toEqual({ label: 'ช่างสังเกต', description: 'มองเห็นรายละเอียดที่คนอื่นพลาด' });
    expect(offer.weakness.label).toBe('กลัวความมืด');
    expect(offer.skills.map((s) => [s.name, s.tier, s.buffType])).toEqual([
      ['อ่านสีหน้า', 'Common', 'Qualitative'],
      ['สายตาเหยี่ยว', 'Common', 'Quantitative'],
      ['เงียบงัน', 'Common', 'Qualitative'],
    ]);
    expect(offer.items.map((s) => [s.name, s.buffType, s.effect])).toEqual([
      ['เสื้อหนังเก่า', 'Quantitative', { type: 'damage_reduction', value: 2 }],
      ['สมุดจดลับ', 'Qualitative', null],
      ['ยาบำรุงกำลัง', 'Quantitative', { type: 'stamina_refund', value: 1 }],
    ]);
    expect(offered.chosen).toBeNull();

    const skill = offer.skills[1]!;
    const item = offer.items[1]!;
    const picked = lootOf(await choose(me.token, { skillIds: [skill.id], itemIds: [item.id] }));

    expect(picked.offer).toBeNull();
    // Q-081: the choice stays changeable until the game starts.
    expect(picked.canReroll).toBe(true);
    expect(picked.chosen).toEqual({ strength: offer.strength, weakness: offer.weakness, skill, item });
    expect(picked.chosen!.skill).toMatchObject({ tier: 'Common', buffType: 'Quantitative', effect: { type: 'check_bonus', scope: 'perception', value: 2 } });
    expect(picked.chosen!.item).toMatchObject({ tier: 'Common', buffType: 'Qualitative' });

    // Still saved after a reload, and in the database (with the trait numbers the player never sees).
    expect(lootOf(await getLoot(me.token)).chosen).toEqual(picked.chosen);
    const row = lootRow(me.member.id)!;
    const chosen = JSON.parse(String(row.chosen_json)) as Record<string, Record<string, unknown>>;
    expect(chosen.strength).toMatchObject({ scope: 'observe', value: 2 });
    expect(chosen.weakness).toMatchObject({ scope: 'stealth', value: -2 });
    expect(chosen.skill).toMatchObject({ tier: 'Common', buffType: 'Quantitative' });
  });

  it('C1: the prompt carries the personality with the name as a token, never a real name (Q-045)', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    lootOf(await rollLoot(me.token));

    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0]!;
    expect(req.purpose).toBe('character_analyze');
    const prompt = [...req.system.map((b) => b.text), ...req.messages.map((m) => m.text)].join('\n');
    expect(prompt).toContain('ช่างสังเกต พูดน้อย ขี้ระแวง กลัวความมืด');
    expect(prompt).toContain(`{{p:${me.member.id}}}`);
    expect(prompt).not.toContain(lin.name);
    expect(prompt).not.toContain(OWNER_NAME);
    expect(prompt).not.toContain(lin.appearance);
  });

  it('C2: more than 3 options or Rare / Legendary ones are not shown: only Common, at most 3', async () => {
    const answer = analysis('', {
      skills: [
        qual('ดาบเทพ', { tier: 'Legendary' }),
        qual('ก้าวเงา', { tier: 'Rare' }),
        qual('ทักษะหนึ่ง'),
        qual('ทักษะสอง'),
        qual('ทักษะสาม'),
        qual('ทักษะสี่'),
      ],
      items: [qual('ของหนึ่ง'), qual('แหวนราชา', { tier: 'Rare' }), qual('ของสอง'), qual('ของสาม'), qual('ของสี่')],
    });
    await start([mockReply.ok(answer)]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(offer.skills.map((s) => s.name)).toEqual(['ทักษะหนึ่ง', 'ทักษะสอง', 'ทักษะสาม']);
    expect(offer.items.map((s) => s.name)).toEqual(['ของหนึ่ง', 'ของสอง', 'ของสาม']);
    expect(JSON.stringify(offer)).not.toMatch(/Rare|Legendary|ดาบเทพ|แหวนราชา/);
  });

  it('C2: when nothing usable is left (all Rare skills) the AI is asked to repair once, and the repair is shown', async () => {
    const bad = analysis('', { skills: [qual('ก้าวเงา', { tier: 'Rare' }), qual('ดาบเทพ', { tier: 'Legendary' })] });
    await start([mockReply.ok(bad), mockReply.ok(analysis('ซ่อม-'))]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(mock.requests).toHaveLength(2);
    const repairText = mock.requests[1]!.messages.map((m) => m.text).join('\n');
    expect(repairText).toContain('skill');
    expect(offer.skills.map((s) => s.name)).toEqual(['ซ่อม-อ่านสีหน้า', 'ซ่อม-สายตาเหยี่ยว', 'ซ่อม-เงียบงัน']);
  });

  it('C2: a repair that is still unusable gives the AI error; nothing is saved and only one repair is tried', async () => {
    const bad = analysis('', { items: [qual('แหวนราชา', { tier: 'Rare' })] });
    await start([mockReply.ok(bad), mockReply.ok(bad)]);
    const me = await playerWithCharacter();

    const res = await rollLoot(me.token);

    expect(res.status).toBe(503);
    expect(ApiError.parse(res.body).code).toBe('ai_unavailable');
    expect(mock.requests).toHaveLength(2);
    expect(lootOf(await getLoot(me.token)).offer).toBeNull();
  });

  it('C2: a trait at a scope the engine does not know needs a repair', async () => {
    const bad = analysis('', { strength: { label: 'โชคดี', scope: 'luck', description: 'ดวงดี' } });
    await start([mockReply.ok(bad), mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(mock.requests).toHaveLength(2);
    expect(offer.strength.label).toBe('ช่างสังเกต');
  });

  it.each([
    ['an effect type the engine has no rule for', { type: 'crit_range', value: 1 }],
    ['a check bonus over the Common cap', { type: 'check_bonus', scope: 'physical', value: 3 }],
    ['a check bonus at an unknown scope', { type: 'check_bonus', scope: 'luck', value: 1 }],
    ['a damage reduction over the Common cap', { type: 'damage_reduction', value: 4 }],
    ['no effect at all', null],
  ])('C3: a Quantitative option with %s is cut; the rest stay', async (_what, effect) => {
    const answer = analysis('', {
      skills: [qual('อ่านสีหน้า'), quant('พลังลึกลับ', effect as Option), qual('เงียบงัน')],
    });
    await start([mockReply.ok(answer)]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(offer.skills.map((s) => s.name)).toEqual(['อ่านสีหน้า', 'เงียบงัน']);
    expect(mock.requests).toHaveLength(1);
  });

  it('C3: every effect the engine supports is kept; a Qualitative option never carries an effect', async () => {
    const answer = analysis('', {
      skills: [
        quant('ฝีมือ', { type: 'check_bonus', scope: 'craft', value: 1 }),
        qual('เล่าเรื่อง', { effect: { type: 'check_bonus', scope: 'social', value: 2 } }),
      ],
    });
    await start([mockReply.ok(answer)]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(offer.skills.map((s) => [s.name, s.buffType, s.effect])).toEqual([
      ['ฝีมือ', 'Quantitative', { type: 'check_bonus', scope: 'craft', value: 1 }],
      ['เล่าเรื่อง', 'Qualitative', null],
    ]);
  });

  it('C3: the effect scopes match the engine status scopes', () => {
    expect([...LOOT_SCOPES]).toEqual([...STATUS_SCOPES]);
  });

  it.each([
    ['two skills', (s: string[], i: string[]) => ({ skillIds: [s[0], s[1]], itemIds: [i[0]] }), { skillIds: 'เลือก skill ได้ 1 อย่างเท่านั้น' }],
    ['no item', (s: string[]) => ({ skillIds: [s[0]], itemIds: [] }), { itemIds: 'กรุณาเลือกไอเท็ม 1 อย่าง' }],
    ['the item missing from the body', (s: string[]) => ({ skillIds: [s[0]] }), { itemIds: 'กรุณาเลือกไอเท็ม 1 อย่าง' }],
    ['two items and no skill', (_s: string[], i: string[]) => ({ skillIds: [], itemIds: [i[0], i[1]] }), {
      skillIds: 'กรุณาเลือก skill 1 อย่าง',
      itemIds: 'เลือกไอเท็มได้ 1 อย่างเท่านั้น',
    }],
    ['an item id as the skill', (_s: string[], i: string[]) => ({ skillIds: [i[0]], itemIds: [i[1]] }), { skillIds: 'skill ที่เลือกไม่อยู่ในตัวเลือก' }],
  ])('C4: choosing %s is refused and nothing is saved', async (_what, body, fields) => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    const offer = lootOf(await rollLoot(me.token)).offer!;

    const res = await choose(me.token, body(offer.skills.map((s) => s.id), offer.items.map((s) => s.id)));

    expect(res.status).toBe(400);
    expect(ApiError.parse(res.body)).toMatchObject({ code: 'invalid_input', fields });
    const after = lootOf(await getLoot(me.token));
    expect(after.chosen).toBeNull();
    expect(after.offer).toEqual(offer);
  });

  it('C4: choosing before any offer exists is refused', async () => {
    await start([]);
    const me = await playerWithCharacter();

    const res = await choose(me.token, { skillIds: ['x'], itemIds: ['y'] });

    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).code).toBe('loot_no_offer');
  });

  it('C5: an AI error or timeout answers 503 with a Thai message; the old set and the reroll count stay', async () => {
    await start([mockReply.ok(analysis()), mockReply.fail('timeout'), mockReply.fail('provider_error'), mockReply.ok(analysis('ใหม่-'))]);
    const me = await playerWithCharacter();
    const first = lootOf(await rollLoot(me.token));

    for (let i = 0; i < 2; i++) {
      const failed = await rollLoot(me.token);
      expect(failed.status).toBe(503);
      const error = ApiError.parse(failed.body);
      expect(error.code).toBe('ai_unavailable');
      expect(error.message).toMatch(/ลองใหม่/);
      const after = lootOf(await getLoot(me.token));
      expect(after.offer).toEqual(first.offer);
      expect(after.rerollsUsed).toBe(0);
    }

    // The retry works and counts as the first reroll.
    const retried = lootOf(await rollLoot(me.token));
    expect(retried.rerollsUsed).toBe(1);
    expect(retried.offer!.skills[0]!.name).toBe('ใหม่-อ่านสีหน้า');
  });

  it('C5: an AI error on the first analysis leaves nothing behind and does not count', async () => {
    await start([mockReply.fail('timeout'), mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    expect((await rollLoot(me.token)).status).toBe(503);
    expect(lootOf(await getLoot(me.token))).toMatchObject({ offer: null, chosen: null, rerollsUsed: 0 });

    const ok = lootOf(await rollLoot(me.token));
    expect(ok.rerollsUsed).toBe(0);
    expect(ok.offer!.skills).toHaveLength(3);
  });

  it('C5: an AI that is not ready answers 503 ai_not_ready without calling it (Q-077)', async () => {
    await start([]);
    const me = await playerWithCharacter();
    aiReady = false;

    const res = await rollLoot(me.token);

    expect(res.status).toBe(503);
    expect(ApiError.parse(res.body)).toMatchObject({ code: 'ai_not_ready', message: 'ยังไม่ได้ตั้งค่า AI' });
    expect(mock.requests).toHaveLength(0);
  });

  it("C6: another player never sees someone else's personality, traits, skills or items", async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    const offer = lootOf(await rollLoot(me.token)).offer!;
    lootOf(await choose(me.token, { skillIds: [offer.skills[0]!.id], itemIds: [offer.items[0]!.id] }));

    const joined = await call('POST', '/api/join', { body: { inviteCode: me.game.inviteCode, name: 'เบล', pin: '1111' } });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const bel = JoinResponse.parse(joined.body);
    const belCharacter = { name: 'เบลล่า', appearance: 'ชายร่างสูงถือไม้เท้า', personality: 'ใจร้อน ชอบเสี่ยง' };
    expect((await call('POST', '/api/game/character', { token: bel.token, body: belCharacter })).status).toBe(201);

    const seen = [
      await getLoot(bel.token),
      await call('GET', '/api/game', { token: bel.token }),
      await call('GET', '/api/game/character', { token: bel.token }),
    ];
    expect(lootOf(seen[0]!)).toMatchObject({ offer: null, chosen: null });
    const text = JSON.stringify(seen.map((r) => r.body));
    for (const secret of ['ช่างสังเกต', 'กลัวความมืด', 'อ่านสีหน้า', 'เสื้อหนังเก่า', 'ขี้ระแวง']) expect(text).not.toContain(secret);

    // Nor can they pick from it: the ids are not in their own (empty) offer.
    const stolen = await choose(bel.token, { skillIds: [offer.skills[1]!.id], itemIds: [offer.items[1]!.id] });
    expect(stolen.status).toBe(409);
    expect(lootRow(bel.member.id)).toBeUndefined();
  });

  it('C6: the Human GM has no loot step; a player without a character gets 404', async () => {
    await start([]);
    const gm = await createGame({ humanGm: true });
    expect((await rollLoot(gm.token)).status).toBe(403);
    expect((await getLoot(gm.token)).status).toBe(403);

    const solo = await createGame({ name: 'ไม่มีตัวละคร' });
    const res = await rollLoot(solo.token);
    expect(res.status).toBe(404);
    expect(ApiError.parse(res.body).code).toBe('character_not_found');
  });

  it('C7: a reroll (unlimited, Q-029) replaces the old set; the old ids can no longer be picked', async () => {
    await start([mockReply.ok(analysis('ชุดแรก-')), mockReply.ok(analysis('ชุดสอง-')), mockReply.ok(analysis('ชุดสาม-'))]);
    const me = await playerWithCharacter();

    const first = lootOf(await rollLoot(me.token));
    expect(first).toMatchObject({ rerollsUsed: 0, rerollLimit: null, canReroll: true });

    const second = lootOf(await rollLoot(me.token));
    expect(second).toMatchObject({ rerollsUsed: 1, rerollLimit: null, canReroll: true });
    expect(second.offer!.skills.map((s) => s.name)).toEqual(['ชุดสอง-อ่านสีหน้า', 'ชุดสอง-สายตาเหยี่ยว', 'ชุดสอง-เงียบงัน']);
    expect(second.offer!.strength.label).toBe('ชุดสอง-ช่างสังเกต');
    expect(lootOf(await getLoot(me.token)).offer).toEqual(second.offer);

    const stale = await choose(me.token, { skillIds: [first.offer!.skills[0]!.id], itemIds: [first.offer!.items[0]!.id] });
    expect(stale.status).toBe(400);

    const third = lootOf(await rollLoot(me.token));
    expect(third.rerollsUsed).toBe(2);
    expect(third.canReroll).toBe(true);
  });

  it('C1 / C7: the default Mock (AI_PROVIDER=mock, no script) gives a usable set, and a reroll gives another', async () => {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash },
      { now: () => clock, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {} },
    );
    const me = await playerWithCharacter();

    const first = lootOf(await rollLoot(me.token)).offer!;
    const second = lootOf(await rollLoot(me.token)).offer!;

    for (const offer of [first, second]) {
      expect(offer.skills).toHaveLength(3);
      expect(offer.items).toHaveLength(3);
      expect(offer.skills.some((s) => s.buffType === 'Quantitative')).toBe(true);
    }
    expect(second.skills.map((s) => s.name)).not.toEqual(first.skills.map((s) => s.name));
  });

  const putCharacter = (token: string, body: unknown) => call('PUT', '/api/game/character', { token, body });
  const startGame = (gameId: string) => server!.db.prepare('update game set started_at = ? where id = ?').run(clock, gameId);
  const pickFirst = (token: string, offer: NonNullable<LootView['offer']>, index = 0) =>
    choose(token, { skillIds: [offer.skills[index]!.id], itemIds: [offer.items[index]!.id] });

  it('Q-081: after choosing, a reroll + a new choice before the start replace the old choice', async () => {
    await start([mockReply.ok(analysis('ชุดแรก-')), mockReply.ok(analysis('ชุดสอง-'))]);
    const me = await playerWithCharacter();
    const first = lootOf(await rollLoot(me.token)).offer!;
    const firstChoice = lootOf(await pickFirst(me.token, first)).chosen!;

    const rerolled = lootOf(await rollLoot(me.token));
    expect(rerolled.offer!.skills[0]!.name).toBe('ชุดสอง-อ่านสีหน้า');
    // The old choice stays until a new one is made.
    expect(rerolled.chosen).toEqual(firstChoice);
    expect(rerolled.canReroll).toBe(true);

    const second = rerolled.offer!;
    const replaced = lootOf(await pickFirst(me.token, second, 2));
    expect(replaced.chosen).toEqual({ strength: second.strength, weakness: second.weakness, skill: second.skills[2], item: second.items[2] });
    expect(replaced.offer).toBeNull();
    expect(lootOf(await getLoot(me.token)).chosen).toEqual(replaced.chosen);
    expect(JSON.parse(String(lootRow(me.member.id)!.chosen_json))).toMatchObject({ strength: { label: 'ชุดสอง-ช่างสังเกต' } });
  });

  it('Q-081: editing the personality clears the offer and the chosen loot', async () => {
    await start([mockReply.ok(analysis()), mockReply.ok(analysis('ค้าง-'))]);
    const me = await playerWithCharacter();
    lootOf(await pickFirst(me.token, lootOf(await rollLoot(me.token)).offer!));
    lootOf(await rollLoot(me.token)); // an offer is pending too

    const res = await putCharacter(me.token, { ...lin, personality: 'ใจดี ชอบช่วยคน กล้าหาญ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(lootOf(await getLoot(me.token))).toMatchObject({ offer: null, chosen: null, canReroll: true });
    const row = lootRow(me.member.id);
    expect(row?.offer_json ?? null).toBeNull();
    expect(row?.chosen_json ?? null).toBeNull();
  });

  it('Q-081: editing only the name or the appearance keeps the loot', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    const chosen = lootOf(await pickFirst(me.token, lootOf(await rollLoot(me.token)).offer!)).chosen!;

    expect((await putCharacter(me.token, { ...lin, name: 'ลินดา', appearance: 'หญิงผ้าคลุมดำ' })).status).toBe(200);

    expect(lootOf(await getLoot(me.token)).chosen).toEqual(chosen);
  });

  it('Q-081: a personality edited while the AI is answering drops that answer (retry, no quota used)', async () => {
    let me: CreateGameResponse | undefined;
    await start([
      () => {
        server!.db.prepare('update character set personality = ? where member_id = ?').run('ใจดี ชอบช่วยคน', me!.member.id);
        return mockReply.ok(analysis('เก่า-'));
      },
    ]);
    me = await playerWithCharacter();

    const res = await rollLoot(me.token);

    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(ApiError.parse(res.body)).toMatchObject({ code: 'ai_unavailable', message: LOOT_AI_FAILED });
    expect(lootOf(await getLoot(me.token))).toMatchObject({ offer: null, chosen: null, rerollsUsed: 0 });
  });

  it('C7 / Q-081: after the game starts, reroll and choose answer 409 game_started and the chosen loot is kept', async () => {
    await start([mockReply.ok(analysis()), mockReply.ok(analysis('ชุดสอง-'))]);
    const me = await playerWithCharacter();
    const chosen = lootOf(await pickFirst(me.token, lootOf(await rollLoot(me.token)).offer!)).chosen!;
    const pending = lootOf(await rollLoot(me.token)).offer!;

    startGame(me.game.id);

    const reroll = await rollLoot(me.token);
    expect(reroll.status).toBe(409);
    expect(ApiError.parse(reroll.body).code).toBe('game_started');
    const pick = await pickFirst(me.token, pending, 1);
    expect(pick.status).toBe(409);
    expect(ApiError.parse(pick.body).code).toBe('game_started');
    expect(mock.requests).toHaveLength(2);

    const after = lootOf(await getLoot(me.token));
    expect(after.chosen).toEqual(chosen);
    expect(after.canReroll).toBe(false);
  });
});
