import { GameView, MemorySourcesResponse, type RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { CONTEXT_BUDGET, estimateTokens, requestTokens } from '../src/gm/context.ts';
import { cannedGmAnswer } from '../src/gm/mock-gm.ts';
import { deleteLearningEntry } from '../src/learning/examples.ts';
import { AVOID_LEAD, LEARNING_BUDGET, LEARNING_HEADS, learningContext, turnTags } from '../src/learning/memory.ts';
import { buildStyles } from '../src/learning/style.ts';
import { ensurePhaseState, recordAction, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/**
 * GEN-083: "ความทรงจำจากเกมก่อน" on the create form (off by default, 1-3 ended games of the owner's player code) and
 * the `learning` blocks `gm_adjudicate` gets (ADR "Learning Across Games" §5-6 + R5): lore / feedback / style before
 * the cache breakpoint, good / avoid matching the turn's tags after it, ≤ 1,500 tokens, never in narrate_*.
 */
const CODE = 'nok-2026';
const OTHER = 'pc-7h2k';

function recordingProvider() {
  const requests: AiCallRequest[] = [];
  const provider: AiProvider & { requests: AiCallRequest[] } = {
    id: 'mock',
    requests,
    ready: () => ({ ok: true }),
    estimateTokens: (text) => Math.ceil(text.length / 3),
    async call(req) {
      requests.push(req);
      return mockReply.ok(await cannedGmAnswer(req));
    },
  };
  return provider;
}

describe('GEN-083 memory from earlier games', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let provider: ReturnType<typeof recordingProvider>;
  const logs: string[] = [];
  const sockets: RoomClient[] = [];

  async function boot() {
    provider = recordingProvider();
    server = await startTestServer(dir, { aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }), aiLog: (l) => logs.push(l) });
  }

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    logs.length = 0;
    await boot();
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  const gameIdOf = (seat: { memberId: string }) => (server!.db.prepare('select game_id as id from member where id = ?').get(seat.memberId) as { id: string }).id;
  const refOf = (memberId: string) => (server!.db.prepare('select ref from character_presence where member_id = ?').get(memberId) as { ref: string }).ref;

  /** A game A created with `code`, played and ended (status finale). */
  async function endedGame(code: string, name: string): Promise<{ t: Table; gameId: string }> {
    const t = await startedTable(server!, false, { playerCode: code, gameName: name });
    const gameId = gameIdOf(t.a);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
    return { t, gameId };
  }

  let ref = 0;
  function seed(gameId: string, type: string, content: string, opts: { tags?: string[]; status?: string; up?: number; createdAt?: number } = {}) {
    const detail = type === 'good_example' || type === 'avoid' ? { kind: 'ruling', npcId: null, up: opts.up ?? 3, down: 3, players: 4 } : {};
    return Number(
      server!.db
        .prepare("insert into learning_entry (type, source_game_id, source_game_name, source_score, source_ref, content, tags, detail, status, created_at) values (?, ?, 'เกมเก่า', null, ?, ?, ?, ?, ?, ?)")
        .run(type, gameId, `ref-${++ref}`, content, JSON.stringify(opts.tags ?? []), JSON.stringify(detail), opts.status ?? 'active', opts.createdAt ?? CLOCK).lastInsertRowid,
    );
  }
  const setSources = (gameId: string, ids: string[] | null) => server!.db.prepare('update game set learning_sources = ? where id = ?').run(ids === null ? null : JSON.stringify(ids), gameId);
  const textOf = (blocks: { text: string }[]) => blocks.map((b) => b.text).join('\n');

  async function playOneTurn(t: Table) {
    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(['แอบขโมยกระเป๋าเงิน', 'ถามข่าวเจ้าของโรงเตี๊ยม', 'สำรวจรอบ ๆ'][i]!, 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    const next = (m: RoomServerMessage) => m.type === 'room' && m.day === 1 && m.phase === 'EOSORIA' && m.turn === 2 && m.status === 'collecting';
    for (const c of clients) await c.waitFor(next);
  }
  const adjudicate = () => provider.requests.find((r) => r.purpose === 'gm_adjudicate')!;

  it('C1: toggle off (the default) → the adjudicate request has no learning section', async () => {
    const old = await endedGame(CODE, 'เกมเก่า');
    seed(old.gameId, 'lore', 'ตำนานเก่าที่ไม่ควรโผล่');
    const t = await startedTable(server!, false, { playerCode: CODE });
    expect((server!.db.prepare('select learning_sources as s from game where id = ?').get(gameIdOf(t.a)) as { s: string | null }).s).toBeNull();
    await playOneTurn(t);
    expect(adjudicate().system.map((b) => b.id)).toEqual(['rules']);
    expect(JSON.stringify(provider.requests)).not.toContain('ตำนานเก่าที่ไม่ควรโผล่');
  });

  it('C2 + C9: on with 2 of 3 games → lore and feedback of those 2 only, in a cached block after the rules; narrate_* get none; the request ≤ 20k', async () => {
    const g1 = await endedGame(CODE, 'เกมหนึ่ง');
    const g2 = await endedGame(CODE, 'เกมสอง');
    const g3 = await endedGame(CODE, 'เกมสาม');
    for (const [g, n] of [[g1, 1], [g2, 2], [g3, 3]] as const) {
      seed(g.gameId, 'lore', `ตำนานเกม${n}`);
      seed(g.gameId, 'feedback_note', `ข้อเสนอเกม${n}`);
    }
    const t = await startedTable(server!, false, { playerCode: CODE, memory: { enabled: true, sourceGameIds: [g1.gameId, g2.gameId] } });
    await playOneTurn(t);

    const req = adjudicate();
    expect(req.system.map((b) => ({ id: b.id, cache: b.cache }))).toEqual([
      { id: 'rules', cache: true },
      { id: 'learning', cache: true },
    ]);
    const learning = req.system[1]!.text;
    for (const s of ['ตำนานเกม1', 'ตำนานเกม2', 'ข้อเสนอเกม1', 'ข้อเสนอเกม2']) expect(learning).toContain(s);
    expect(learning).not.toContain('เกม3');
    expect(estimateTokens(learning)).toBeLessThanOrEqual(LEARNING_BUDGET.total);
    expect(requestTokens(req.system, req.messages)).toBeLessThanOrEqual(CONTEXT_BUDGET.gm_adjudicate);

    const narrations = provider.requests.filter((r) => r.purpose.startsWith('narrate_'));
    expect(narrations.length).toBeGreaterThan(0);
    for (const r of narrations) {
      expect(r.system.some((b) => b.id.startsWith('learning'))).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/ตำนานเกม|ข้อเสนอเกม/);
    }
  });

  it('C3: the source list = ended games the code was a member of (newest first, no score gate); an unknown code → 403; a game not of the list → 400', async () => {
    const g1 = await endedGame(CODE, 'เกมจบแล้วหนึ่ง');
    const g2 = await endedGame(CODE, 'เกมจบแล้วสอง');
    await startedTable(server!, false, { playerCode: CODE, gameName: 'เกมยังไม่จบ' });
    const other = await endedGame(OTHER, 'เกมของคนอื่น');
    server!.db.prepare("update game_phase set updated_at = updated_at + 1000 where game_id = ?").run(g2.gameId);

    const res = await g1.t.call('POST', '/api/memory/sources', { body: { playerCode: CODE.toUpperCase() } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(MemorySourcesResponse.parse(res.body).games.map((g) => [g.name, g.score])).toEqual([
      ['เกมจบแล้วสอง', null],
      ['เกมจบแล้วหนึ่ง', null],
    ]);
    expect((await g1.t.call('POST', '/api/memory/sources', { body: { playerCode: 'never-used' } })).status).toBe(403);

    const create = (extra: Record<string, unknown>) =>
      g1.t.call('POST', '/api/games', { body: { createCode: 'ลับเฉพาะ-2026', gameName: 'ใหม่', mode: 'single', humanGm: false, name: 'นก', pin: '1234', ...extra } });
    const refused = await create({ playerCode: CODE, memory: { enabled: true, sourceGameIds: [other.gameId] } });
    expect(refused.status).toBe(400);
    expect((refused.body as { fields: Record<string, string> }).fields.memory).toBeDefined();
    expect((await create({ memory: { enabled: true, sourceGameIds: [g1.gameId] } })).status).toBe(400);
    expect((await create({ playerCode: CODE, memory: { enabled: true, sourceGameIds: [g1.gameId, g2.gameId, other.gameId, 'x'] } })).status).toBe(400);
    const ok = await create({ playerCode: CODE, memory: { enabled: true, sourceGameIds: [g1.gameId] } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as { game: GameView }).game.memory).toEqual({ enabled: true, sources: [{ id: g1.gameId, name: 'เกมจบแล้วหนึ่ง' }] });
  });

  it('C4: the turn\'s tag steal (from the latest gm_turn tagging) → good ≤ 3 and avoid ≤ 3 after the cache breakpoint, avoid led by its Thai line', async () => {
    const old = await endedGame(CODE, 'เกมเก่า');
    for (let i = 1; i <= 4; i++) {
      seed(old.gameId, 'good_example', `ขโมยดีที่${i}`, { tags: ['steal'], up: 10 - i });
      seed(old.gameId, 'avoid', `ขโมยแย่ที่${i}`, { tags: ['steal'] });
    }
    seed(old.gameId, 'good_example', 'รักษาดี', { tags: ['heal'] });
    const t = await startedTable(server!, false, { playerCode: CODE, memory: { enabled: true, sourceGameIds: [old.gameId] } });
    const gameId = gameIdOf(t.a);

    // The AI GM tagged A's last action STEAL (Q-365 A: labels of the stored proposal only).
    const at = { day: 1, phase: 'EOSORIA' as const, turn: 1 as const };
    recordAction(server!.orm, gameId, at, t.a.memberId, { text: 'ขโมย', visibility: 'public', rest: false }, CLOCK);
    server!.db
      .prepare("insert into gm_turn (game_id, day, phase, turn, status, proposal, rolls, updated_at) values (?, 1, 'EOSORIA', 1, 'applied', ?, '[]', 0)")
      .run(gameId, JSON.stringify({ actions: [{ actionId: 'act-1', actor: refOf(t.a.memberId), tagging: { verbTags: ['STEAL'], targetTags: [], activate: [] } }] }));
    const tags = turnTags(server!.orm, gameId, [t.a.memberId, t.b.memberId]);
    expect(tags).toEqual(['steal']);

    const { blocks } = learningContext(server!.orm, gameId, { tags, room: 20_000 });
    expect(blocks.map((b) => [b.id, b.cache])).toEqual([
      ['learning', true],
      ['learning-turn', false],
    ]);
    const turn = blocks[1]!.text;
    expect(turn.match(/ขโมยดีที่/g)).toHaveLength(3);
    expect(turn).not.toContain('ขโมยดีที่4');
    expect(turn.match(/ขโมยแย่ที่/g)).toHaveLength(3);
    expect(turn).toContain(AVOID_LEAD);
    expect(turn.indexOf(AVOID_LEAD)).toBeLessThan(turn.indexOf('ขโมยแย่ที่'));
    expect(turn).not.toContain('รักษาดี');
    // No tag this turn and nothing else stored → no block at all.
    expect(learningContext(server!.orm, gameId, { tags: [], room: 20_000 }).blocks).toEqual([]);
  });

  it('C5: over the budget → cut avoid → good (keep 1) → style → feedback → lore (keep 1) → the whole block; never over the room or 1,500', async () => {
    const old = await endedGame(CODE, 'เกมเก่า');
    for (let i = 0; i < 6; i++) seed(old.gameId, 'lore', `ตำนาน${i} ${'ก'.repeat(120)}`, { createdAt: CLOCK + i });
    for (let i = 0; i < 3; i++) seed(old.gameId, 'feedback_note', `ข้อเสนอ${i} ${'ข'.repeat(80)}`);
    for (let i = 0; i < 3; i++) seed(old.gameId, 'good_example', `ดี${i} ${'ค'.repeat(140)}`, { tags: ['steal'] });
    for (let i = 0; i < 3; i++) seed(old.gameId, 'avoid', `เลี่ยง${i} ${'ง'.repeat(60)}`, { tags: ['steal'] });
    // B played the old game with the same code: a style line for this game.
    const t = await startedTable(server!, false, { playerCode: CODE, memory: { enabled: true, sourceGameIds: [old.gameId] } });
    const gameId = gameIdOf(t.a);
    recordAction(server!.orm, old.gameId, { day: 1, phase: 'EOSORIA', turn: 1 }, old.t.a.memberId, { text: 'ขโมย', visibility: 'public', rest: false }, CLOCK);
    server!.db
      .prepare("insert into gm_turn (game_id, day, phase, turn, status, proposal, rolls, updated_at) values (?, 1, 'EOSORIA', 1, 'applied', ?, '[]', 0)")
      .run(old.gameId, JSON.stringify({ actions: [{ actionId: 'act-1', actor: refOf(old.t.a.memberId), tagging: { verbTags: ['STEAL'], targetTags: [], activate: [] } }] }));
    buildStyles(server!.orm, old.gameId, CLOCK);

    const shape = (room: number) => {
      const r = learningContext(server!.orm, gameId, { tags: ['steal'], room });
      const all = textOf(r.blocks);
      const count = (re: RegExp) => (all.match(re) ?? []).length;
      expect(estimateTokens(all)).toBeLessThanOrEqual(Math.min(room, LEARNING_BUDGET.total));
      return { trimmed: r.trimmed, empty: r.blocks.length === 0, lore: count(/ตำนาน\d/g), feedback: count(/ข้อเสนอ\d/g), style: all.includes(LEARNING_HEADS.style), good: count(/ดี\d /g), avoid: count(/เลี่ยง\d/g) };
    };
    // Each section within its own cap (lore 450 = 3 of these, feedback 200 = 2, avoid 150 = 2 lines of ≤ 50).
    const full = shape(20_000);
    expect(full).toEqual({ trimmed: 0, empty: false, lore: 3, feedback: 2, style: true, good: 3, avoid: 2 });

    let last = full;
    for (let room = 1_500; room >= 0; room -= 25) {
      const s = shape(room);
      expect(s.trimmed).toBeGreaterThanOrEqual(last.trimmed);
      if (s.good < 3) expect(s.avoid).toBe(0);
      if (!s.style) expect(s.good).toBeLessThanOrEqual(1);
      if (s.feedback === 0) expect(s.style).toBe(false);
      if (s.lore < 3) expect(s.feedback).toBe(0);
      last = s;
    }
    expect(last.empty).toBe(true);
    expect(shape(400)).toMatchObject({ lore: 1, feedback: 0, style: false, good: 1, avoid: 0 });
  });

  it('C6: an entry deleted in the library or suspended mid-game is gone the next turn, without a crash', async () => {
    const old = await endedGame(CODE, 'เกมเก่า');
    const lore = seed(old.gameId, 'lore', 'ตำนานที่จะถูกลบ');
    const good = seed(old.gameId, 'good_example', 'ตัวอย่างที่จะพัก', { tags: ['steal'] });
    seed(old.gameId, 'lore', 'ตำนานที่ยังอยู่');
    const t = await startedTable(server!, false, { playerCode: CODE, memory: { enabled: true, sourceGameIds: [old.gameId] } });
    const gameId = gameIdOf(t.a);
    const now = () => textOf(learningContext(server!.orm, gameId, { tags: ['steal'], room: 20_000 }).blocks);
    expect(now()).toContain('ตำนานที่จะถูกลบ');
    expect(now()).toContain('ตัวอย่างที่จะพัก');
    expect(deleteLearningEntry(server!.orm, lore)).toBe(true);
    server!.db.prepare("update learning_entry set status = 'suspended' where id = ?").run(good);
    expect(now()).not.toMatch(/ตำนานที่จะถูกลบ|ตัวอย่างที่จะพัก/);
    expect(now()).toContain('ตำนานที่ยังอยู่');
    server!.db.prepare('delete from learning_entry').run();
    expect(learningContext(server!.orm, gameId, { tags: ['steal'], room: 20_000 })).toEqual({ blocks: [], trimmed: 0 });
  });

  it('C7: once the game started, changing the setting → 409; before the start the owner may change it', async () => {
    const old = await endedGame(CODE, 'เกมเก่า');
    const call = old.t.call;
    const created = await call('POST', '/api/games', { body: { createCode: 'ลับเฉพาะ-2026', gameName: 'ใหม่', mode: 'online', humanGm: false, name: 'นก', pin: '1234', playerCode: CODE } });
    const owner = (created.body as { token: string }).token;
    const on = await call('PATCH', '/api/game', { token: owner, body: { memory: { enabled: true, sourceGameIds: [old.gameId] } } });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(GameView.parse(on.body).memory).toEqual({ enabled: true, sources: [{ id: old.gameId, name: 'เกมเก่า' }] });
    expect((await call('PATCH', '/api/game', { token: owner, body: { memory: { enabled: true, sourceGameIds: ['not-mine'] } } })).status).toBe(409);

    const t = await startedTable(server!, false, { playerCode: CODE, memory: { enabled: true, sourceGameIds: [old.gameId] } });
    const res = await t.call('PATCH', '/api/game', { token: t.a.token, body: { memory: { enabled: false } } });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('game_started');
    expect((server!.db.prepare('select learning_sources as s from game where id = ?').get(gameIdOf(t.a)) as { s: string }).s).toBe(JSON.stringify([old.gameId]));
  });

  it('C8: players of the new game have no style profile → no style section, no error', async () => {
    const old = await endedGame(OTHER, 'เกมเก่า');
    seed(old.gameId, 'lore', 'ตำนานเก่า');
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a);
    setSources(gameId, [old.gameId]);
    const text = textOf(learningContext(server!.orm, gameId, { tags: [], room: 20_000 }).blocks);
    expect(text).toContain('ตำนานเก่า');
    expect(text).not.toContain(LEARNING_HEADS.style);
  });

  it('C10: after a restart (GEN-037) the setting and its source games are the same', async () => {
    const g1 = await endedGame(CODE, 'เกมหนึ่ง');
    const g2 = await endedGame(CODE, 'เกมสอง');
    const t = await startedTable(server!, false, { playerCode: CODE, memory: { enabled: true, sourceGameIds: [g2.gameId, g1.gameId] } });
    const before = GameView.parse((await t.call('GET', '/api/game', { token: t.a.token })).body).memory;
    expect(before).toEqual({ enabled: true, sources: [{ id: g2.gameId, name: 'เกมสอง' }, { id: g1.gameId, name: 'เกมหนึ่ง' }] });
    await server!.close();
    await boot();
    const after = await caller(server!)('GET', '/api/game', { token: t.a.token });
    expect(GameView.parse(after.body).memory).toEqual(before);
  });
});
