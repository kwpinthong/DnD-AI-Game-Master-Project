import { ApiError, CreateGameResponse, JoinResponse, LOOT_SCOPES, LootResponse, type LootOption, type LootView } from '@isekai/protocol';
import { STATUS_SCOPES } from '@isekai/rules';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { createMockProvider, mockReply, type MockProvider } from '../src/ai/providers/mock.ts';
import { loadGameAssets } from '../src/assets/load.ts';
import { abilitySource, itemSource } from '../src/assets/tags.ts';
import { hashPin } from '../src/auth/pin.ts';
import { crossPlayerState } from '../src/crossplayer/phase.ts';
import { tagContexts } from '../src/crossplayer/tags.ts';
import { LOOT_AI_FAILED } from '../src/game/loot.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir, withLooks } from './helpers.ts';

const CREATE_CODE = 'ลับเฉพาะ-2026';
const assets = loadGameAssets();

/** The personality names the character, so the prompt check (Q-045) has something to catch. */
const lin = withLooks({
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง',
  personality: 'ลินเป็นคนช่างสังเกต พูดน้อย ขี้ระแวง กลัวความมืด',
});
const OWNER_NAME = 'นกฮูก';

/** Rank B rows of the sheet (Ability `Name`, Item English name), three sets for rerolls. */
const SKILL_SETS = [
  ['Glare of Truth', 'Plea of Mercy', 'Ward of Light'],
  ['Clear Horizon', 'Neutral Guard', 'Rational Paradox'],
  ['Stasis Anchor', 'Calculated Blow', 'Scapegoat Veil'],
] as const;
const ITEM_SETS = [
  ['Prism of Truth', 'Blessed Loaf of Dawn', 'Cloak of Grey Dust'],
  ['Scales of Fair Trade', 'Lead-Core Pocket Watch', 'Silver Rosary of Hearth'],
  ['Mask of the Faceless', 'Vial of Black Ash', 'Shadow-Silk Lockpick'],
] as const;
const rankA = {
  skill: assets.abilities.find((a) => a.rank === 'A')!.name,
  item: assets.items.find((i) => i.rank === 'A')!.nameEn,
};

/** What the AI answers for `character_analyze`: traits + names of 3 skills + 3 items from set `n`. */
function analysis(n = 0, patch: Record<string, unknown> = {}) {
  const prefix = n === 0 ? '' : `ชุด${n + 1}-`;
  return {
    strength: { label: `${prefix}ช่างสังเกต`, scope: 'observe', description: 'มองเห็นรายละเอียดที่คนอื่นพลาด' },
    weakness: { label: `${prefix}กลัวความมืด`, scope: 'stealth', description: 'ในที่มืดใจสั่น' },
    skills: [...SKILL_SETS[n]!],
    items: [...ITEM_SETS[n]!],
    ...patch,
  };
}

/** The option must be the sheet row of that name, with its tags and numbers (C1, C4). */
function expectSheetRow(option: LootOption) {
  expect(option.rank).toBe('B');
  if (option.kind === 'skill') {
    const row = assets.ability(option.name) ?? expect.fail(`no Ability row "${option.name}"`);
    expect(row.rank).toBe('B');
    expect(option).toMatchObject({
      description: row.description,
      triggerType: row.triggerType,
      dailyLimit: row.dailyLimit,
      verbTags: row.matchVerbTags,
      targetTags: row.matchTargetTags,
      effects: row.effects,
    });
  } else {
    const row = assets.item(option.name) ?? expect.fail(`no Item row "${option.name}"`);
    expect(row.rank).toBe('B');
    expect(option.name).toBe(row.nameEn);
    expect(option).toMatchObject({
      description: row.effect,
      triggerType: row.triggerType,
      dailyLimit: row.dailyLimit,
      verbTags: row.matchVerbTags,
      targetTags: row.matchTargetTags,
      effects: row.effects,
    });
  }
}

/** A Common option as GEN-048 stored it, before the sheet (C5). */
const legacyOption = (id: string, kind: 'skill' | 'item', name: string, effect: unknown = null) => ({
  id,
  kind,
  name,
  description: `${name} แบบเดิม`,
  tier: 'Common',
  buffType: effect ? 'Quantitative' : 'Qualitative',
  effect,
});
const legacyChosen = {
  strength: { label: 'ช่างสังเกต', description: 'เดิม', scope: 'observe', value: 2 },
  weakness: { label: 'กลัวความมืด', description: 'เดิม', scope: 'stealth', value: -2 },
  skill: legacyOption('old-s1', 'skill', 'สายตาเหยี่ยว', { type: 'check_bonus', scope: 'perception', value: 2 }),
  item: legacyOption('old-i1', 'item', 'เสื้อหนังเก่า', { type: 'damage_reduction', value: 2 }),
};
const legacyOffer = {
  strength: legacyChosen.strength,
  weakness: legacyChosen.weakness,
  skills: [legacyChosen.skill],
  items: [legacyChosen.item],
};

type Step = AiCallResult | ((req: AiCallRequest) => AiCallResult);

describe('character loot from the Asset sheet: Rank B skills / items (GEN-048, GEN-073)', { timeout: 60_000 }, () => {
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

  /** A server with the default Mock (AI_PROVIDER=mock, no script). */
  async function startDefaultMock() {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash },
      { now: () => clock, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {} },
    );
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
  const putCharacter = (token: string, body: unknown) => call('PUT', '/api/game/character', { token, body });
  const startGame = (gameId: string) => server!.db.prepare('update game set started_at = ? where id = ?').run(clock, gameId);
  const pickFirst = (token: string, offer: NonNullable<LootView['offer']>, index = 0) =>
    choose(token, { skillIds: [offer.skills[index]!.id], itemIds: [offer.items[index]!.id] });
  const seedLoot = (memberId: string, offer: unknown, chosen: unknown) =>
    server!.db
      .prepare('insert into character_loot (member_id, offer_json, chosen_json, rerolls_used, updated_at) values (?, ?, ?, 0, ?)')
      .run(memberId, offer === null ? null : JSON.stringify(offer), chosen === null ? null : JSON.stringify(chosen), clock);

  // --- GEN-073 C1: the offer is Rank B rows of the sheet ---

  it('C1: Mock offers 3 skills + 3 items; every one is a Rank B row of the sheet (exact name, tags, numbers)', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    const offered = lootOf(await rollLoot(me.token));

    const offer = offered.offer!;
    expect(offer.strength).toEqual({ label: 'ช่างสังเกต', description: 'มองเห็นรายละเอียดที่คนอื่นพลาด' });
    expect(offer.weakness.label).toBe('กลัวความมืด');
    expect(offer.skills.map((s) => [s.kind, s.name])).toEqual(SKILL_SETS[0].map((n) => ['skill', n]));
    expect(offer.items.map((s) => [s.kind, s.name])).toEqual(ITEM_SETS[0].map((n) => ['item', n]));
    [...offer.skills, ...offer.items].forEach(expectSheetRow);
    expect(offered.chosen).toBeNull();
    expect(offered.needsNewChoice).toBe(false);
    expect(JSON.stringify(offer)).not.toContain('Common');
  });

  it('C1: the default Mock (no script) offers Rank B sheet rows, and a reroll gives another set', async () => {
    await startDefaultMock();
    const me = await playerWithCharacter();

    const first = lootOf(await rollLoot(me.token)).offer!;
    const second = lootOf(await rollLoot(me.token)).offer!;

    for (const offer of [first, second]) {
      expect(offer.skills).toHaveLength(3);
      expect(offer.items).toHaveLength(3);
      [...offer.skills, ...offer.items].forEach(expectSheetRow);
    }
    expect(second.skills.map((s) => s.name)).not.toEqual(first.skills.map((s) => s.name));
  });

  it('C1: the prompt lists the Rank B rows with their tags (no Rank A+), and the personality only with name tokens (Q-045)', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    lootOf(await rollLoot(me.token));

    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0]!;
    expect(req.purpose).toBe('character_analyze');
    const system = req.system.map((b) => b.text).join('\n');
    for (const row of assets.abilities.filter((a) => a.rank === 'B')) {
      expect(system).toContain(row.name);
      for (const tag of row.matchVerbTags) expect(system).toContain(tag);
    }
    for (const row of assets.items.filter((i) => i.rank === 'B')) expect(system).toContain(row.nameEn);
    for (const row of assets.abilities.filter((a) => a.rank !== 'B')) expect(system).not.toContain(row.name);
    for (const row of assets.items.filter((i) => i.rank !== 'B')) expect(system).not.toContain(row.nameEn);

    const prompt = [system, ...req.messages.map((m) => m.text)].join('\n');
    expect(prompt).toContain('ช่างสังเกต พูดน้อย ขี้ระแวง กลัวความมืด');
    expect(prompt).toContain(`{{p:${me.member.id}}}`);
    expect(prompt).not.toContain(lin.name);
    expect(prompt).not.toContain(OWNER_NAME);
    expect(prompt).not.toContain(lin.appearance);
  });

  // --- GEN-073 C2: names not in the data, or Rank A+, are cut or repaired once ---

  it('C2: a name not in the sheet, a Rank A+ row, or a skill named as an item is cut; the rest stay (at most 3)', async () => {
    const answer = analysis(0, {
      skills: ['ดาบเทพ', rankA.skill, 'Prism of Truth', 'Glare of Truth', 'Plea of Mercy', 'Ward of Light', 'Clear Horizon'],
      items: [rankA.item, 'Prism of Truth', 'Glare of Truth', 'แหวนราชา', 'Cloak of Grey Dust'],
    });
    await start([mockReply.ok(answer)]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(offer.skills.map((s) => s.name)).toEqual(['Glare of Truth', 'Plea of Mercy', 'Ward of Light']);
    expect(offer.items.map((s) => s.name)).toEqual(['Prism of Truth', 'Cloak of Grey Dust']);
    expect(mock.requests).toHaveLength(1);
    expect(JSON.stringify(offer)).not.toMatch(new RegExp(`ดาบเทพ|แหวนราชา|${rankA.skill}|${rankA.item}`));
  });

  it('C2: an item named by its full sheet cell is kept under its English name', async () => {
    const full = assets.item('Prism of Truth')!.name;
    await start([mockReply.ok(analysis(0, { items: [full] }))]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(offer.items.map((s) => s.name)).toEqual(['Prism of Truth']);
  });

  it('C2: when no skill is left (unknown / Rank A names) the AI is asked to repair once, and the repair is shown', async () => {
    const bad = analysis(0, { skills: ['ก้าวเงา', rankA.skill] });
    await start([mockReply.ok(bad), mockReply.ok(analysis(1))]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(mock.requests).toHaveLength(2);
    const repairText = mock.requests[1]!.messages.map((m) => m.text).join('\n');
    expect(repairText).toContain('skill');
    expect(repairText).toContain('Rank B');
    expect(offer.skills.map((s) => s.name)).toEqual([...SKILL_SETS[1]]);
  });

  it('C2: a repair that is still unusable gives the AI error; nothing is saved and only one repair is tried', async () => {
    const bad = analysis(0, { items: [rankA.item] });
    await start([mockReply.ok(bad), mockReply.ok(bad)]);
    const me = await playerWithCharacter();

    const res = await rollLoot(me.token);

    expect(res.status).toBe(503);
    expect(ApiError.parse(res.body).code).toBe('ai_unavailable');
    expect(mock.requests).toHaveLength(2);
    expect(lootOf(await getLoot(me.token)).offer).toBeNull();
  });

  it('C2: a trait at a scope the engine does not know needs a repair', async () => {
    const bad = analysis(0, { strength: { label: 'โชคดี', scope: 'luck', description: 'ดวงดี' } });
    await start([mockReply.ok(bad), mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(mock.requests).toHaveLength(2);
    expect(offer.strength.label).toBe('ช่างสังเกต');
  });

  it('C2: the trait scopes match the engine status scopes', () => {
    expect([...LOOT_SCOPES]).toEqual([...STATUS_SCOPES]);
  });

  // --- GEN-073 C3: duplicates in one set ---

  it('C3: the same row twice in one set is kept once (also with spaces or the full item cell)', async () => {
    const answer = analysis(0, {
      skills: ['Glare of Truth', ' Glare of Truth ', 'Plea of Mercy', 'Glare of Truth'],
      items: ['Prism of Truth', assets.item('Prism of Truth')!.name, 'Prism of Truth'],
    });
    await start([mockReply.ok(answer)]);
    const me = await playerWithCharacter();

    const offer = lootOf(await rollLoot(me.token)).offer!;

    expect(offer.skills.map((s) => s.name)).toEqual(['Glare of Truth', 'Plea of Mercy']);
    expect(offer.items.map((s) => s.name)).toEqual(['Prism of Truth']);
    expect(new Set([...offer.skills, ...offer.items].map((o) => o.id)).size).toBe(3);
  });

  // --- GEN-073 C4: the kept skill / item carry the sheet's tags and numbers, and tag matching uses them ---

  it('C4: the chosen skill / item keep the sheet tags and numbers, and tag matching (GEN-064) binds them to their rows', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    const offer = lootOf(await rollLoot(me.token)).offer!;
    const skill = offer.skills.find((s) => s.name === 'Glare of Truth')!;
    const item = offer.items.find((s) => s.name === 'Prism of Truth')!;

    const picked = lootOf(await choose(me.token, { skillIds: [skill.id], itemIds: [item.id] }));

    expect(picked.chosen).toEqual({ strength: offer.strength, weakness: offer.weakness, skill, item });
    expectSheetRow(picked.chosen!.skill);
    expectSheetRow(picked.chosen!.item);
    expect(lootOf(await getLoot(me.token)).chosen).toEqual(picked.chosen);
    const row = JSON.parse(String(lootRow(me.member.id)!.chosen_json)) as Record<string, Record<string, unknown>>;
    expect(row.strength).toMatchObject({ scope: 'observe', value: 2 });
    expect(row.weakness).toMatchObject({ scope: 'stealth', value: -2 });

    // The game starts: the engine sees the skill and the item, tag matching finds their rows.
    startGame(me.game.id);
    server!.db
      .prepare('insert into character_presence (member_id, game_id, ref, location_id, updated_at) values (?, ?, ?, ?, ?)')
      .run(me.member.id, me.game.id, 'ref-lin', 'nowhere', clock);
    const state = crossPlayerState(server!.orm, me.game.id);
    const player = state.players[me.member.id]!;
    expect(player.skills).toEqual([{ id: skill.id, tier: 'Common' }]);
    expect(player.items).toEqual([{ id: item.id, tier: 'Common' }]);
    // Sheet numbers come through tag matching, not as an old Common gear status.
    expect(player.statuses.filter((s) => s.origin === 'gear')).toEqual([]);

    const contexts = tagContexts(server!.orm, me.game.id, state, { assets, day: 1 });
    expect(contexts[me.member.id]!.sources).toEqual([
      abilitySource(skill.id, assets.ability('Glare of Truth')!),
      itemSource(item.id, assets.item('Prism of Truth')!),
    ]);
  });

  // --- GEN-073 C5: a character that kept Common loot before the change ---

  it('C5: a kept Common set from before the change still loads; before the start the player is asked to choose again', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    seedLoot(me.member.id, null, legacyChosen);

    const loaded = lootOf(await getLoot(me.token));

    expect(loaded).toMatchObject({ offer: null, chosen: null, needsNewChoice: true, canReroll: true });

    // Choosing again from a new (Rank B) offer replaces it.
    const offer = lootOf(await rollLoot(me.token)).offer!;
    [...offer.skills, ...offer.items].forEach(expectSheetRow);
    const picked = lootOf(await pickFirst(me.token, offer));
    expect(picked).toMatchObject({ needsNewChoice: false });
    expect(picked.chosen!.skill.name).toBe(SKILL_SETS[0][0]);
  });

  it('C5: a pending Common offer from before the change is not offered; a new analysis is needed', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    seedLoot(me.member.id, legacyOffer, null);

    expect(lootOf(await getLoot(me.token))).toMatchObject({ offer: null, chosen: null, canReroll: true });
    const res = await choose(me.token, { skillIds: ['old-s1'], itemIds: ['old-i1'] });
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).code).toBe('loot_no_offer');

    expect(lootOf(await rollLoot(me.token)).offer!.skills.map((s) => s.name)).toEqual([...SKILL_SETS[0]]);
  });

  it('C5: in a game that already started, the old Common set still loads and the engine still applies it', async () => {
    await start([]);
    const me = await playerWithCharacter();
    seedLoot(me.member.id, null, legacyChosen);
    startGame(me.game.id);

    const loaded = lootOf(await getLoot(me.token));

    expect(loaded.needsNewChoice).toBe(false);
    expect(loaded.canReroll).toBe(false);
    expect(loaded.chosen!.skill).toMatchObject({ id: 'old-s1', name: 'สายตาเหยี่ยว', rank: null, verbTags: [], effects: [] });
    expect(loaded.chosen!.item).toMatchObject({ id: 'old-i1', name: 'เสื้อหนังเก่า', rank: null });

    server!.db
      .prepare('insert into character_presence (member_id, game_id, ref, location_id, updated_at) values (?, ?, ?, ?, ?)')
      .run(me.member.id, me.game.id, 'ref-lin', 'nowhere', clock);
    const player = crossPlayerState(server!.orm, me.game.id).players[me.member.id]!;
    expect(player.skills).toEqual([{ id: 'old-s1', tier: 'Common' }]);
    expect(player.damageReduction).toBe(2);
    expect(player.statuses.find((s) => s.origin === 'gear')).toMatchObject({ mods: [{ scope: 'perception', value: 2 }] });
  });

  // --- GEN-048 rules that stay (GEN-073 C6) ---

  it.each([
    ['two skills', (s: string[], i: string[]) => ({ skillIds: [s[0], s[1]], itemIds: [i[0]] }), { skillIds: 'เลือก skill ได้ 1 อย่างเท่านั้น' }],
    ['no item', (s: string[]) => ({ skillIds: [s[0]], itemIds: [] }), { itemIds: 'กรุณาเลือกไอเท็ม 1 อย่าง' }],
    ['the item missing from the body', (s: string[]) => ({ skillIds: [s[0]] }), { itemIds: 'กรุณาเลือกไอเท็ม 1 อย่าง' }],
    ['two items and no skill', (_s: string[], i: string[]) => ({ skillIds: [], itemIds: [i[0], i[1]] }), {
      skillIds: 'กรุณาเลือก skill 1 อย่าง',
      itemIds: 'เลือกไอเท็มได้ 1 อย่างเท่านั้น',
    }],
    ['an item id as the skill', (_s: string[], i: string[]) => ({ skillIds: [i[0]], itemIds: [i[1]] }), { skillIds: 'skill ที่เลือกไม่อยู่ในตัวเลือก' }],
  ])('C6 (GEN-048 C4): choosing %s is refused and nothing is saved', async (_what, body, fields) => {
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

  it('C6 (GEN-048 C4): choosing before any offer exists is refused', async () => {
    await start([]);
    const me = await playerWithCharacter();

    const res = await choose(me.token, { skillIds: ['x'], itemIds: ['y'] });

    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).code).toBe('loot_no_offer');
  });

  it('C6 (GEN-048 C5): an AI error or timeout answers 503 with a Thai message; the old set and the reroll count stay', async () => {
    await start([mockReply.ok(analysis()), mockReply.fail('timeout'), mockReply.fail('provider_error'), mockReply.ok(analysis(1))]);
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
    expect(retried.offer!.skills[0]!.name).toBe(SKILL_SETS[1][0]);
  });

  it('C6 (GEN-048 C5): an AI error on the first analysis leaves nothing behind and does not count', async () => {
    await start([mockReply.fail('timeout'), mockReply.ok(analysis())]);
    const me = await playerWithCharacter();

    expect((await rollLoot(me.token)).status).toBe(503);
    expect(lootOf(await getLoot(me.token))).toMatchObject({ offer: null, chosen: null, rerollsUsed: 0 });

    const ok = lootOf(await rollLoot(me.token));
    expect(ok.rerollsUsed).toBe(0);
    expect(ok.offer!.skills).toHaveLength(3);
  });

  it('C6 (Q-077): an AI that is not ready answers 503 ai_not_ready without calling it', async () => {
    await start([]);
    const me = await playerWithCharacter();
    aiReady = false;

    const res = await rollLoot(me.token);

    expect(res.status).toBe(503);
    expect(ApiError.parse(res.body)).toMatchObject({ code: 'ai_not_ready', message: 'ยังไม่ได้ตั้งค่า AI' });
    expect(mock.requests).toHaveLength(0);
  });

  it("C6 (GEN-048 C6): another player never sees someone else's personality, traits, skills or items", async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    const offer = lootOf(await rollLoot(me.token)).offer!;
    lootOf(await choose(me.token, { skillIds: [offer.skills[0]!.id], itemIds: [offer.items[0]!.id] }));

    const joined = await call('POST', '/api/join', { body: { inviteCode: me.game.inviteCode, name: 'เบล', pin: '1111' } });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const bel = JoinResponse.parse(joined.body);
    const belCharacter = withLooks({ name: 'เบลล่า', appearance: 'ชายร่างสูงถือไม้เท้า', personality: 'ใจร้อน ชอบเสี่ยง' });
    expect((await call('POST', '/api/game/character', { token: bel.token, body: belCharacter })).status).toBe(201);

    const seen = [
      await getLoot(bel.token),
      await call('GET', '/api/game', { token: bel.token }),
      await call('GET', '/api/game/character', { token: bel.token }),
    ];
    expect(lootOf(seen[0]!)).toMatchObject({ offer: null, chosen: null });
    const text = JSON.stringify(seen.map((r) => r.body));
    for (const secret of ['ช่างสังเกต', 'กลัวความมืด', ...SKILL_SETS[0], ...ITEM_SETS[0], 'ขี้ระแวง']) expect(text).not.toContain(secret);

    // Nor can they pick from it: the ids are not in their own (empty) offer.
    const stolen = await choose(bel.token, { skillIds: [offer.skills[1]!.id], itemIds: [offer.items[1]!.id] });
    expect(stolen.status).toBe(409);
    expect(lootRow(bel.member.id)).toBeUndefined();
  });

  it('C6 (GEN-048 C6): the Human GM has no loot step; a player without a character gets 404', async () => {
    await start([]);
    const gm = await createGame({ humanGm: true });
    expect((await rollLoot(gm.token)).status).toBe(403);
    expect((await getLoot(gm.token)).status).toBe(403);

    const solo = await createGame({ name: 'ไม่มีตัวละคร' });
    const res = await rollLoot(solo.token);
    expect(res.status).toBe(404);
    expect(ApiError.parse(res.body).code).toBe('character_not_found');
  });

  it('C6 (GEN-048 C7, Q-029): a reroll (unlimited) replaces the old set; the old ids can no longer be picked', async () => {
    await start([mockReply.ok(analysis(0)), mockReply.ok(analysis(1)), mockReply.ok(analysis(2))]);
    const me = await playerWithCharacter();

    const first = lootOf(await rollLoot(me.token));
    expect(first).toMatchObject({ rerollsUsed: 0, rerollLimit: null, canReroll: true });

    const second = lootOf(await rollLoot(me.token));
    expect(second).toMatchObject({ rerollsUsed: 1, rerollLimit: null, canReroll: true });
    expect(second.offer!.skills.map((s) => s.name)).toEqual([...SKILL_SETS[1]]);
    expect(second.offer!.strength.label).toBe('ชุด2-ช่างสังเกต');
    expect(lootOf(await getLoot(me.token)).offer).toEqual(second.offer);

    const stale = await choose(me.token, { skillIds: [first.offer!.skills[0]!.id], itemIds: [first.offer!.items[0]!.id] });
    expect(stale.status).toBe(400);

    const third = lootOf(await rollLoot(me.token));
    expect(third.rerollsUsed).toBe(2);
    expect(third.canReroll).toBe(true);
  });

  it('C6 (GEN-048 C7): a reroll of the same rows gives new ids, so an old pick never lands on the new set', async () => {
    await start([mockReply.ok(analysis(0)), mockReply.ok(analysis(0))]);
    const me = await playerWithCharacter();
    const first = lootOf(await rollLoot(me.token)).offer!;
    const second = lootOf(await rollLoot(me.token)).offer!;

    expect(second.skills.map((s) => s.name)).toEqual(first.skills.map((s) => s.name));
    expect(second.skills.map((s) => s.id).some((id) => first.skills.some((s) => s.id === id))).toBe(false);
    expect((await pickFirst(me.token, first)).status).toBe(400);
  });

  it('C6 (Q-081): after choosing, a reroll + a new choice before the start replace the old choice', async () => {
    await start([mockReply.ok(analysis(0)), mockReply.ok(analysis(1))]);
    const me = await playerWithCharacter();
    const first = lootOf(await rollLoot(me.token)).offer!;
    const firstChoice = lootOf(await pickFirst(me.token, first)).chosen!;

    const rerolled = lootOf(await rollLoot(me.token));
    expect(rerolled.offer!.skills[0]!.name).toBe(SKILL_SETS[1][0]);
    // The old choice stays until a new one is made.
    expect(rerolled.chosen).toEqual(firstChoice);
    expect(rerolled.canReroll).toBe(true);

    const second = rerolled.offer!;
    const replaced = lootOf(await pickFirst(me.token, second, 2));
    expect(replaced.chosen).toEqual({ strength: second.strength, weakness: second.weakness, skill: second.skills[2], item: second.items[2] });
    expect(replaced.offer).toBeNull();
    expect(lootOf(await getLoot(me.token)).chosen).toEqual(replaced.chosen);
    expect(JSON.parse(String(lootRow(me.member.id)!.chosen_json))).toMatchObject({ strength: { label: 'ชุด2-ช่างสังเกต' } });
  });

  it('C6 (Q-081, Q-098): editing the personality clears the offer and the chosen loot; the reroll count stays', async () => {
    await start([mockReply.ok(analysis(0)), mockReply.ok(analysis(1)), mockReply.ok(analysis(2))]);
    const me = await playerWithCharacter();
    lootOf(await rollLoot(me.token));
    lootOf(await pickFirst(me.token, lootOf(await rollLoot(me.token)).offer!)); // 1 reroll used
    lootOf(await rollLoot(me.token)); // an offer is pending too

    const res = await putCharacter(me.token, { ...lin, personality: 'ใจดี ชอบช่วยคน กล้าหาญ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(lootOf(await getLoot(me.token))).toMatchObject({ offer: null, chosen: null, canReroll: true, rerollsUsed: 1 });
    const row = lootRow(me.member.id);
    expect(row?.offer_json ?? null).toBeNull();
    expect(row?.chosen_json ?? null).toBeNull();
  });

  it('C6 (Q-081): editing only the name or the appearance keeps the loot', async () => {
    await start([mockReply.ok(analysis())]);
    const me = await playerWithCharacter();
    const chosen = lootOf(await pickFirst(me.token, lootOf(await rollLoot(me.token)).offer!)).chosen!;

    expect((await putCharacter(me.token, withLooks({ ...lin, name: 'ลินดา', appearance: 'หญิงผ้าคลุมดำ' }))).status).toBe(200);

    expect(lootOf(await getLoot(me.token)).chosen).toEqual(chosen);
  });

  it('C6 (Q-081): a personality edited while the AI is answering drops that answer (retry, no quota used)', async () => {
    let me: CreateGameResponse | undefined;
    await start([
      () => {
        server!.db.prepare('update character set personality = ? where member_id = ?').run('ใจดี ชอบช่วยคน', me!.member.id);
        return mockReply.ok(analysis());
      },
    ]);
    me = await playerWithCharacter();

    const res = await rollLoot(me.token);

    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(ApiError.parse(res.body)).toMatchObject({ code: 'ai_unavailable', message: LOOT_AI_FAILED });
    expect(lootOf(await getLoot(me.token))).toMatchObject({ offer: null, chosen: null, rerollsUsed: 0 });
  });

  it('C6 (GEN-048 C7, Q-081): after the game starts, reroll and choose answer 409 game_started and the chosen loot is kept', async () => {
    await start([mockReply.ok(analysis(0)), mockReply.ok(analysis(1))]);
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

  // --- GEN-109: the AI writes {{p:id}} into trait text; the view shows the character name, never the token ---

  it('GEN-109 C1/C5/C6: own token shows the character name (offer and old saved choice), follows a rename; others / unknown ids are a neutral word', async () => {
    let own = '';
    await start([
      () =>
        mockReply.ok(
          analysis(0, {
            strength: { label: 'ช่างสังเกต', scope: 'observe', description: `ช่างสังเกตเงียบ ๆ — ${own} เป็นคนเงียบ` },
            weakness: { label: 'กลัวความมืด', scope: 'stealth', description: `${own} กลัวที่มืด คุยกับ {{p:someone-else}} ไม่เก่ง` },
          }),
        ),
    ]);
    const me = await playerWithCharacter();
    own = `{{p:${me.member.id}}}`;

    const offer = lootOf(await rollLoot(me.token)).offer!;
    expect(offer.strength.description).toBe(`ช่างสังเกตเงียบ ๆ — ${lin.name} เป็นคนเงียบ`);
    expect(offer.weakness.description).toBe(`${lin.name} กลัวที่มืด คุยกับ ใครบางคน ไม่เก่ง`);

    const chosen = lootOf(await pickFirst(me.token, offer)).chosen!;
    expect(JSON.stringify([chosen.strength, chosen.weakness])).not.toMatch(/\{\{|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(chosen.strength.description).toBe(offer.strength.description);

    expect((await putCharacter(me.token, { ...lin, name: 'ลินดา' })).status).toBe(200);
    expect(lootOf(await getLoot(me.token)).chosen!.strength.description).toBe('ช่างสังเกตเงียบ ๆ — ลินดา เป็นคนเงียบ');
  });
});
