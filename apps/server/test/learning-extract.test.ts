import { AiUsageOverviewResponse, LearningExtractResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest } from '../src/ai/provider.ts';
import { createMockProvider, type MockProvider } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import { loadConfig } from '../src/config.ts';
import { extractDue } from '../src/learning/extract.ts';
import { ensurePhaseState, insertEntry, recordAction, savePhaseState } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, startedTable, type Table } from './visibility-fixture.ts';

/**
 * GEN-080: the lore + feedback_note extract of an ended game (ADR "Learning Across Games" + Revised GEN-108). No score
 * gate; the average rating is stored as `sourceScore`. The AI sees only what the end page shows (no GM-only data, no
 * lobby name), once per game, usage under purpose `learning_extract`.
 */
const ADMIN_CODE = 'ทดสอบ-สกัดความรู้-080';
const LOBBY_NAMES = ['นก', 'บี', 'ซี'];
const CANARIES = ['CANARY_SAGA', 'CANARY_JOURNAL', 'CANARY_GMNOTE', 'CANARY_PRIVATE', 'CANARY_UNREVEALED'];

interface Answer {
  lore?: unknown;
  feedback?: unknown;
}

describe('GEN-080 learning extract (lore + feedback_note)', { timeout: 120_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let provider: MockProvider;
  let logs: string[] = [];
  /** What the mock answers a `learning_extract` call; undefined = the built-in mock answer. */
  let answer: ((req: AiCallRequest) => Answer) | undefined;
  let fail = false;

  async function boot(custom: boolean) {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    logs = [];
    const config = loadAiConfig({ AI_PROVIDER: 'mock', AI_RETRY_DELAY_MS: '0', AI_MAX_RETRIES: '0' });
    provider = createMockProvider(config);
    const inner = provider.call.bind(provider);
    // A wrapper: the canned answer unless a test sets one, and a failure on demand (C7).
    const wrapped: MockProvider = {
      ...provider,
      async call(req) {
        if (req.purpose === 'learning_extract' && fail) {
          provider.requests.push(req);
          return { ok: false, error: 'timeout', detail: 'mock timeout', usage: null, retryable: true, latencyMs: 0 };
        }
        if (req.purpose === 'learning_extract' && custom && answer) {
          provider.requests.push(req);
          return { ok: true, json: answer(req), model: req.model, latencyMs: 0, usage: { inputTokens: 900, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 120 } };
        }
        return inner(req);
      },
    };
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${tmp.dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: config, aiProvider: wrapped, aiLog: (line) => logs.push(line), rng: null },
    );
  }

  beforeEach(() => {
    answer = undefined;
    fail = false;
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const extractCalls = () => provider.requests.filter((r) => r.purpose === 'learning_extract');
  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const entries = (gameId: string) =>
    server!.db.prepare('select type, source_game_id as sourceGameId, source_score as sourceScore, source_ref as sourceRef, content, tags, detail, status from learning_entry where source_game_id = ? order by id').all(gameId) as {
      type: string;
      sourceGameId: string;
      sourceScore: number | null;
      sourceRef: string;
      content: string;
      tags: string;
      detail: string;
      status: string;
    }[];

  async function adminToken(t: Table) {
    const res = await t.call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(res.status).toBe(200);
    return (res.body as { token: string }).token;
  }

  async function extract(t: Table, gameId: string, token?: string) {
    return t.call('POST', `/api/admin/learning/games/${gameId}/extract`, { token: token ?? (await adminToken(t)) });
  }

  /** A started game with GM-only canaries, a private narration and a kicked player's Secret action; `end` ends it. */
  async function seeded(end = true) {
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    const db = server!.db;
    const npc = getGameScenario(server!.orm, gameId)!.npcs[0]!;
    const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;
    db.prepare("insert into gm_memory (game_id, kind, day, text, created_at) values (?, 'saga', 1, 'CANARY_SAGA', 0)").run(gameId);
    db.prepare("insert into gm_journal (game_id, member_id, kind, day, text, created_at) values (?, ?, 'day', 1, 'CANARY_JOURNAL', 0)").run(gameId, t.a.memberId);
    db.prepare("insert into gm_turn (game_id, day, phase, turn, status, proposal, rolls, updated_at) values (?, 1, 'EOSORIA', 1, 'applied', ?, '[]', 0)").run(gameId, JSON.stringify({ gmNote: 'CANARY_GMNOTE', actions: [] }));
    insertEntry(server!.orm, gameId, { kind: 'narration', at, locationId: null, text: 'CANARY_PRIVATE เสียงกระซิบถึงคนเดียว' }, [t.a.memberId], CLOCK);
    recordAction(server!.orm, gameId, at, t.b.memberId, { text: 'แอบหยิบถุงเงินในตลาด', visibility: 'secret', rest: false }, CLOCK);
    recordAction(server!.orm, gameId, at, t.c.memberId, { text: 'CANARY_UNREVEALED แอบวางยา', visibility: 'secret', rest: false }, CLOCK);
    db.prepare('update member set kicked_at = ? where id = ?').run(CLOCK, t.c.memberId);
    // The finale narration (the epilogue on the end page) names the NPC and the lobby name of A.
    insertEntry(server!.orm, gameId, { kind: 'narration', meta: { finale: true }, at, locationId: null, text: `เมืองรอดเพราะ ${npc.name} และนก ยืนอยู่หน้าโบสถ์` }, [t.a.memberId, t.b.memberId], CLOCK);
    if (end) {
      db.prepare("insert into game_ending (game_id, reason, path, outcomes, narrated_at, created_at) values (?, 'finale', 'good', ?, 0, 0)").run(gameId, JSON.stringify({ [t.a.memberId]: 'survived', [t.b.memberId]: 'defeated' }));
      savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
    }
    return { t, gameId, npc };
  }

  async function rate(t: Table, who: { token: string }, score: number, comment = '') {
    const res = await t.call('PUT', '/api/game/rating', { token: who.token, body: { score, comment } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  const GOOD: Answer = {
    lore: [
      { content: 'รอบก่อนเมืองรอดจากอุกกาบาตด้วยม่านปาฏิหาริย์', tags: ['ending_good', 'meteor'], npcIds: [] },
      { content: 'ลินผู้ใจดีรอดชีวิตจนวันสุดท้าย', tags: ['survivor'], npcIds: [] },
    ],
    feedback: { content: 'ผู้เล่นอยากให้ GM เล่าฉากต่อสู้สั้นลงและบอกผลชัดขึ้น' },
  };

  it('C1: an ended game → ≥ 1 lore and 1 feedback_note with sourceGameId and sourceScore = the average then', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded();
    await rate(t, t.a, 9, 'ฉากต่อสู้ยาวไป');
    await rate(t, t.b, 8, 'อยากรู้ผลชัดกว่านี้');
    const res = await extract(t, gameId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(LearningExtractResponse.parse(res.body)).toEqual({ status: 'done', message: expect.any(String), lore: 2, feedback: 1 });
    const rows = entries(gameId);
    expect(rows.filter((r) => r.type === 'lore')).toHaveLength(2);
    expect(rows.filter((r) => r.type === 'feedback_note')).toHaveLength(1);
    for (const r of rows) {
      expect(r).toMatchObject({ sourceGameId: gameId, sourceScore: 8.5, status: 'active' });
    }
    expect(JSON.parse(rows.find((r) => r.type === 'feedback_note')!.detail)).toEqual({ fromComments: 2 });
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ endingPath: 'good' });
    expect(JSON.parse(rows[0]!.tags)).toEqual(['ending_good', 'meteor']);
  });

  it('C2: the prompt holds only end-page data: no unrevealed Secret, gmNote / proposal / saga / journal / private narration, no lobby name', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId, npc } = await seeded();
    await rate(t, t.a, 7, 'บีเล่นเก่งมาก');
    expect((await extract(t, gameId)).status).toBe(200);
    expect(extractCalls()).toHaveLength(1);
    const prompt = JSON.stringify(extractCalls()[0]!);
    for (const canary of CANARIES) expect(prompt).not.toContain(canary);
    // Short Thai lobby names hide inside other words (เป็นกลาง holds นก), so the check is where they were written.
    for (const name of LOBBY_NAMES) expect(prompt).not.toContain(`\\"${name}\\"`);
    expect(prompt).not.toContain('และนก ยืน');
    expect(prompt).not.toContain('บีเล่น');
    expect(prompt).toContain('และผู้เล่น ยืน');
    expect(prompt).not.toContain(npc.name);
    // What the end page shows is there: the revealed Secret action, the epilogue (NPC as its token), the comment.
    expect(prompt).toContain('แอบหยิบถุงเงินในตลาด');
    expect(prompt).toContain(`{{n:${npc.id}}}`);
    expect(prompt).toContain('เล่นเก่งมาก');
  });

  it('C3: a game not ended → no entry, 0 calls (409)', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded(false);
    const res = await extract(t, gameId);
    expect(res.status).toBe(409);
    expect(extractCalls()).toHaveLength(0);
    expect(entries(gameId)).toEqual([]);
  });

  it('C4: an ended game averaging 3.00 still gets lore (no score gate)', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded();
    await rate(t, t.a, 3, 'น่าเบื่อ');
    await rate(t, t.b, 3);
    expect((await extract(t, gameId)).status).toBe(200);
    const lore = entries(gameId).filter((r) => r.type === 'lore');
    expect(lore.length).toBeGreaterThanOrEqual(1);
    expect(lore[0]!.sourceScore).toBe(3);
  });

  it('C5: an ended game nobody rated → lore, no feedback_note, sourceScore empty', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded();
    const body = LearningExtractResponse.parse((await extract(t, gameId)).body);
    expect(body).toMatchObject({ status: 'done', lore: 2, feedback: 0 });
    const rows = entries(gameId);
    expect(rows.map((r) => r.type)).toEqual(['lore', 'lore']);
    expect(rows.every((r) => r.sourceScore === null)).toBe(true);
  });

  it('C6: extracting again stores nothing new and makes no call', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded();
    await rate(t, t.a, 9, 'ดี');
    const token = await adminToken(t);
    expect((await extract(t, gameId, token)).status).toBe(200);
    const before = entries(gameId);
    const again = LearningExtractResponse.parse((await extract(t, gameId, token)).body);
    expect(again).toMatchObject({ status: 'done', lore: 2, feedback: 1 });
    expect(entries(gameId)).toEqual(before);
    expect(extractCalls()).toHaveLength(1);
  });

  it('C7: an AI error or timeout → no half entries, status "สกัดไม่สำเร็จ", the owner retries', async () => {
    await boot(true);
    answer = () => GOOD;
    fail = true;
    const { t, gameId } = await seeded();
    await rate(t, t.a, 9, 'ดี');
    const token = await adminToken(t);
    const failed = LearningExtractResponse.parse((await extract(t, gameId, token)).body);
    expect(failed).toEqual({ status: 'failed', message: 'สกัดไม่สำเร็จ', lore: 0, feedback: 0 });
    expect(entries(gameId)).toEqual([]);
    expect(server!.db.prepare('select status from learning_extract where game_id = ?').get(gameId)).toEqual({ status: 'failed' });

    fail = false;
    expect(LearningExtractResponse.parse((await extract(t, gameId, token)).body)).toMatchObject({ status: 'done', lore: 2, feedback: 1 });
    expect(extractCalls()).toHaveLength(2);
    // Only the server owner: a player's token is 403.
    expect(await t.call('POST', `/api/admin/learning/games/${gameId}/extract`, { token: t.a.token })).toMatchObject({ status: 403 });
  });

  it('C8: a lore with a lobby name → one retry; still there → that entry is not stored + a log line', async () => {
    await boot(true);
    answer = () => ({
      lore: [
        { content: 'นกเป็นคนช่วยเมืองไว้', tags: [], npcIds: [] },
        { content: 'เมืองรอดจากอุกกาบาต', tags: ['ending_good'], npcIds: [] },
      ],
      feedback: null,
    });
    const { t, gameId } = await seeded();
    const body = LearningExtractResponse.parse((await extract(t, gameId)).body);
    expect(body).toMatchObject({ status: 'done', lore: 1 });
    expect(extractCalls()).toHaveLength(2);
    expect(entries(gameId).map((r) => r.content)).toEqual(['เมืองรอดจากอุกกาบาต']);
    expect(logs.some((l) => l.includes('[learning]') && l.includes('dropped'))).toBe(true);
    // The log names neither the text nor the name.
    expect(logs.join('\n')).not.toContain('นกเป็นคน');
  });

  it('C9: a successful extract is one ai_usage row of purpose learning_extract on the usage page', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded();
    const token = await adminToken(t);
    expect((await extract(t, gameId, token)).status).toBe(200);
    expect(server!.db.prepare("select game_id as gameId, ok from ai_usage where purpose = 'learning_extract'").all()).toEqual([{ gameId, ok: 1 }]);
    const usage = AiUsageOverviewResponse.parse((await t.call('GET', '/api/admin/ai-usage', { token })).body);
    const row = usage.byPurpose.find((p) => p.purpose === 'learning_extract');
    expect(row?.totals).toMatchObject({ calls: 1, okCalls: 1 });
    expect(row!.totals.inputTokens).toBeGreaterThan(0);
  });

  it('C10: with the built-in Mock, two new test games give the same stable lore', async () => {
    await boot(false);
    const first = await seeded();
    const second = await seeded();
    const token = await adminToken(first.t);
    for (const g of [first, second]) expect(LearningExtractResponse.parse((await extract(g.t, g.gameId, token)).body).status).toBe('done');
    const contents = (gameId: string) => entries(gameId).map((r) => `${r.type}:${r.content}`);
    expect(contents(first.gameId).length).toBeGreaterThan(0);
    expect(contents(first.gameId)).toEqual(contents(second.gameId));
  });

  it('every member rating the game starts the extract by itself', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded();
    await rate(t, t.a, 9, 'ดี');
    expect(extractCalls()).toHaveLength(0);
    await rate(t, t.b, 8);
    await vi.waitFor(() => expect(entries(gameId).length).toBe(3));
    expect(extractCalls()).toHaveLength(1);
  });

  it('Q-363: a failed extract shows "failed" to the game owner on the end page, who retries it there; others get 403', async () => {
    await boot(true);
    answer = () => GOOD;
    const { t, gameId } = await seeded();
    const status = (token: string) => t.call('GET', '/api/game/learning', { token });
    const retry = (token: string) => t.call('POST', '/api/game/learning/extract', { token });
    expect(await status(t.a.token)).toMatchObject({ status: 200, body: { status: 'pending' } });
    fail = true;
    expect((await extract(t, gameId)).status).toBe(200);
    expect(await status(t.a.token)).toMatchObject({ status: 200, body: { status: 'failed' } });
    // Not the owner (B is a player of the game): 403, nothing runs.
    expect((await status(t.b.token)).status).toBe(403);
    expect((await retry(t.b.token)).status).toBe(403);
    expect(extractCalls()).toHaveLength(1);
    fail = false;
    expect(await retry(t.a.token)).toMatchObject({ status: 200, body: { status: 'done' } });
    expect(entries(gameId).filter((r) => r.type === 'lore')).toHaveLength(2);
    expect(await status(t.a.token)).toMatchObject({ status: 200, body: { status: 'done' } });
  });

  it('Q-363: before the end the owner gets 409 and no call', async () => {
    await boot(true);
    const { t } = await seeded(false);
    expect((await t.call('GET', '/api/game/learning', { token: t.a.token })).status).toBe(409);
    expect((await t.call('POST', '/api/game/learning/extract', { token: t.a.token })).status).toBe(409);
    expect(extractCalls()).toHaveLength(0);
  });

  it('Q-364: an ended game not extracted is due N hours after it ended; extracted, failed or not ended is not', async () => {
    await boot(true);
    const due = await seeded();
    const done = await seeded();
    const failed = await seeded();
    const playing = await seeded(false);
    server!.db.prepare("insert into learning_extract (game_id, status, error, updated_at) values (?, 'done', null, 0), (?, 'failed', 'timeout', 0)").run(done.gameId, failed.gameId);
    const HOUR = 3_600_000;
    expect(extractDue(server!.orm, CLOCK + 23 * HOUR, 24 * HOUR)).toEqual([]);
    expect(extractDue(server!.orm, CLOCK + 24 * HOUR, 24 * HOUR)).toEqual([due.gameId]);
    expect(extractDue(server!.orm, CLOCK + 24 * HOUR, 24 * HOUR)).not.toContain(playing.gameId);
  });

  it('Q-364: LEARNING_AUTO_EXTRACT_HOURS: default 24, 0 = off, anything else not a number stops the start', () => {
    const base = { DB_PATH: 'x.sqlite' };
    expect(loadConfig(base).learningAutoExtractMs).toBe(24 * 3_600_000);
    expect(loadConfig({ ...base, LEARNING_AUTO_EXTRACT_HOURS: '2' }).learningAutoExtractMs).toBe(2 * 3_600_000);
    expect(loadConfig({ ...base, LEARNING_AUTO_EXTRACT_HOURS: '0' }).learningAutoExtractMs).toBeUndefined();
    expect(() => loadConfig({ ...base, LEARNING_AUTO_EXTRACT_HOURS: 'soon' })).toThrow(/LEARNING_AUTO_EXTRACT_HOURS/);
  });
});
