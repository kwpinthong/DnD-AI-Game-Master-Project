import { AdminSessionResponse, AiUsageGameResponse, AiUsageOverviewResponse, CreateGameResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_SESSION_TTL_MS } from '../src/admin/session.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { createUsageStore, type UsageRecord } from '../src/ai/core/usage.ts';
import { hashPin } from '../src/auth/pin.ts';
import { CREATE_CODE_LIMIT } from '../src/game/create-code.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { approveHeldTurn } from './gm-console-client.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, startedTable, type Call } from './visibility-fixture.ts';

// GEN-061: the server owner's AI usage dashboard (Q-058: the server owner only, not game owners or GMs).

const ADMIN_CODE = 'เจ้าของเซิร์ฟเวอร์-ทดสอบ-2026';

describe('AI usage dashboard (GEN-061)', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let clock = CLOCK;
  let call: Call;
  let logLines: string[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    clock = CLOCK;
    logLines = [];
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** Ceiling 1 USD per game per month, so the 80 % / 100 % cases need small numbers. */
  async function boot(withAdmin = true) {
    server = await startServer(
      {
        host: '127.0.0.1',
        port: 0,
        dbPath: `${dataDir}/isekai.sqlite`,
        createCodeHash: await hashPin(CREATE_CODE),
        ...(withAdmin ? { adminCodeHash: await hashPin(ADMIN_CODE) } : {}),
      },
      { now: () => clock, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_GAME_MONTHLY_USD: '1' }), aiLog: (line) => logLines.push(line) },
    );
    call = caller(server);
    return server;
  }

  async function adminToken(): Promise<string> {
    const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AdminSessionResponse.parse(res.body).token;
  }

  /** A game with only its owner (no AI call yet). */
  async function newGame(gameName = 'เกมทดสอบ') {
    const res = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName, mode: 'online', humanGm: false, name: 'เจ้าของเกม', pin: '1234' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const created = CreateGameResponse.parse(res.body);
    return { gameId: created.game.id, ownerToken: created.token };
  }

  function record(gameId: string, row: Partial<UsageRecord> = {}) {
    createUsageStore(server!.orm).record({
      gameId,
      day: 1,
      phase: 'EOSORIA',
      turn: 1,
      purpose: 'gm_adjudicate',
      provider: 'mock',
      model: 'claude-sonnet-5-5',
      tokens: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
      costUsdMicros: 3000,
      ok: true,
      failureReason: null,
      attempt: 1,
      latencyMs: 10,
      createdAt: clock,
      ...row,
    });
  }

  async function gameUsage(gameId: string, token: string) {
    const res = await call('GET', `/api/admin/ai-usage/${gameId}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AiUsageGameResponse.parse(res.body);
  }

  describe('admin code → short-lived admin token', () => {
    it('the right code gives a token; a wrong code is 403 wrong_admin_code', async () => {
      await boot();
      const wrong = await call('POST', '/api/admin/session', { body: { code: 'ไม่ใช่' } });
      expect(wrong.status).toBe(403);
      expect(wrong.body).toMatchObject({ code: 'wrong_admin_code' });
      expect(JSON.stringify(wrong.body)).not.toContain('ไม่ใช่');

      const ok = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
      expect(ok.status).toBe(200);
      const session = AdminSessionResponse.parse(ok.body);
      expect(new Date(session.expiresAt).getTime()).toBe(CLOCK + ADMIN_SESSION_TTL_MS);
      expect((await call('GET', '/api/admin/ai-usage', { token: session.token })).status).toBe(200);
    });

    it('without ADMIN_CODE_HASH the dashboard is closed: 503 admin_disabled, and data routes 403', async () => {
      await boot(false);
      const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'admin_disabled' });
      expect((await call('GET', '/api/admin/ai-usage')).status).toBe(403);
    });

    it('too many wrong codes block the admin login for a while (429), even with the right code', async () => {
      await boot();
      for (let i = 0; i < CREATE_CODE_LIMIT.maxFailures; i++) await call('POST', '/api/admin/session', { body: { code: `ผิด-${i}` } });
      const blocked = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ code: 'too_many_attempts' });
    });

    it('Q-170: wrong codes count per client IP (X-Forwarded-For first hop): one IP locked, another still logs in', async () => {
      await boot();
      const from = (ip: string) => ({ 'x-forwarded-for': `${ip}, 10.0.0.1` });
      for (let i = 0; i < CREATE_CODE_LIMIT.maxFailures; i++) {
        await call('POST', '/api/admin/session', { body: { code: `ผิด-${i}` }, headers: from('203.0.113.5') });
      }
      const blocked = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE }, headers: from('203.0.113.5') });
      expect(blocked.status).toBe(429);
      // One log line for the lock: masked IP, no code.
      const lockLines = logLines.filter((l) => l.startsWith('[admin]'));
      expect(lockLines).toHaveLength(1);
      expect(lockLines[0]).toContain('203.0.113.x');
      expect(lockLines.join('\n')).not.toMatch(/203\.0\.113\.5|ผิด-|เจ้าของเซิร์ฟเวอร์/);
      // Same first hop, different proxy chain after it: still the same client.
      expect((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE }, headers: { 'x-forwarded-for': '203.0.113.5' } })).status).toBe(429);
      const other = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE }, headers: from('198.51.100.7') });
      expect(other.status).toBe(200);
      // No header: the socket address is the client, and it has no failures.
      expect((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).status).toBe(200);
      // The lock still ends after 10 minutes.
      clock += CREATE_CODE_LIMIT.lockMs;
      expect((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE }, headers: from('203.0.113.5') })).status).toBe(200);
    });

    it('Q-170: 9 wrong codes from one IP and 9 from another lock nobody', async () => {
      await boot();
      for (const ip of ['203.0.113.5', '198.51.100.7']) {
        for (let i = 0; i < CREATE_CODE_LIMIT.maxFailures - 1; i++) {
          await call('POST', '/api/admin/session', { body: { code: `ผิด-${i}` }, headers: { 'x-forwarded-for': ip } });
        }
      }
      expect((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE }, headers: { 'x-forwarded-for': '203.0.113.5' } })).status).toBe(200);
    });

    it('the token expires after its TTL and stops working after logout', async () => {
      await boot();
      const token = await adminToken();
      clock += ADMIN_SESSION_TTL_MS + 1;
      expect((await call('GET', '/api/admin/ai-usage', { token })).status).toBe(403);

      const again = await adminToken();
      expect((await call('POST', '/api/admin/logout', { token: again })).status).toBe(204);
      expect((await call('GET', '/api/admin/ai-usage', { token: again })).status).toBe(403);
    });
  });

  it('C1: 3 calls (resolve 2, day summary 1) → totals of input / cached / output, cost, and per purpose', async () => {
    await boot();
    const { gameId } = await newGame();
    record(gameId, { tokens: { inputTokens: 1000, cachedInputTokens: 500, cacheWriteTokens: 0, outputTokens: 200 }, costUsdMicros: 4050 });
    record(gameId, { turn: 2, tokens: { inputTokens: 1200, cachedInputTokens: 800, cacheWriteTokens: 0, outputTokens: 300 }, costUsdMicros: 5480 });
    record(gameId, {
      purpose: 'summarize_day',
      model: 'claude-haiku-5-5',
      phase: 'NOCTHERION',
      turn: null,
      tokens: { inputTokens: 600, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 150 },
      costUsdMicros: 135,
    });
    const token = await adminToken();

    const usage = await gameUsage(gameId, token);
    expect(usage.game).toEqual({ id: gameId, name: 'เกมทดสอบ' });
    expect(usage.totals).toEqual({
      calls: 3,
      okCalls: 3,
      failedCalls: 0,
      inputTokens: 2800,
      cachedInputTokens: 1300,
      cacheWriteTokens: 0,
      outputTokens: 650,
      costUsdMicros: 9665,
      unpricedCalls: 0,
    });
    const byPurpose = Object.fromEntries(usage.byPurpose.map((p) => [p.purpose, p.totals]));
    expect(Object.keys(byPurpose).sort()).toEqual(['gm_adjudicate', 'summarize_day']);
    expect(byPurpose.gm_adjudicate).toMatchObject({ calls: 2, inputTokens: 2200, cachedInputTokens: 1300, outputTokens: 500, costUsdMicros: 9530 });
    expect(byPurpose.summarize_day).toMatchObject({ calls: 1, inputTokens: 600, outputTokens: 150, costUsdMicros: 135 });

    // The owner's overview across games has the same numbers for this game, and an empty game too.
    const other = await newGame('อีกเกม');
    const overview = await call('GET', '/api/admin/ai-usage', { token });
    expect(overview.status).toBe(200);
    const all = AiUsageOverviewResponse.parse(overview.body);
    expect(all.totals.calls).toBe(3);
    expect(all.games.find((g) => g.game.id === gameId)?.totals).toEqual(usage.totals);
    expect(all.games.find((g) => g.game.id === other.gameId)?.totals.calls).toBe(0);
    expect(all.games[0]!.game.id, 'games with activity come first').toBe(gameId);
  });

  it('C2: a call on day 3 SOLARION is counted in the day 3 SOLARION cell only', async () => {
    await boot();
    const { gameId } = await newGame();
    record(gameId, { day: 1, phase: 'EOSORIA', tokens: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } });
    record(gameId, { day: 3, phase: 'SOLARION', tokens: { inputTokens: 777, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 77 } });
    record(gameId, { day: 3, phase: 'HESPERION', tokens: { inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 } });
    record(gameId, { day: null, phase: null, turn: null, purpose: 'character_analyze' });

    const usage = await gameUsage(gameId, await adminToken());
    const cell = (day: number | null, phase: string | null) => usage.byPeriod.find((p) => p.day === day && p.phase === phase);
    expect(cell(3, 'SOLARION')?.totals).toMatchObject({ calls: 1, inputTokens: 777, outputTokens: 77 });
    expect(cell(3, 'HESPERION')?.totals).toMatchObject({ calls: 1, inputTokens: 5 });
    expect(cell(1, 'EOSORIA')?.totals).toMatchObject({ calls: 1, inputTokens: 100 });
    expect(cell(null, null)?.totals.calls, 'calls outside a turn (loot at character creation)').toBe(1);
    expect(usage.byPeriod.filter((p) => p.totals.inputTokens === 777)).toHaveLength(1);
    // Ordered by day, then the 4 periods of the day; the no-period row last.
    expect(usage.byPeriod.map((p) => `${p.day}:${p.phase}`)).toEqual(['1:EOSORIA', '3:SOLARION', '3:HESPERION', 'null:null']);
  });

  it('C3: 80 % of the game ceiling this month is a warning, 100 % is reached (last month does not count)', async () => {
    await boot();
    const { gameId } = await newGame();
    const token = await adminToken();
    record(gameId, { costUsdMicros: 900_000, createdAt: Date.UTC(2026, 9, 30) }); // October: not this month's ceiling
    record(gameId, { costUsdMicros: 790_000 });
    expect((await gameUsage(gameId, token)).ceiling).toEqual({ spentUsdMicros: 790_000, ceilingUsdMicros: 1_000_000, percent: 79, status: 'ok' });

    record(gameId, { costUsdMicros: 10_000 });
    expect((await gameUsage(gameId, token)).ceiling).toMatchObject({ spentUsdMicros: 800_000, percent: 80, status: 'warning' });

    record(gameId, { costUsdMicros: 200_000 });
    const reached = await gameUsage(gameId, token);
    expect(reached.ceiling).toMatchObject({ spentUsdMicros: 1_000_000, percent: 100, status: 'reached' });
    // All-time totals still include October.
    expect(reached.totals.costUsdMicros).toBe(1_900_000);

    // The AI service really stops for this game: the dashboard says what the GM loop does.
    const result = await server!.ai.call({
      gameId,
      purpose: 'gm_adjudicate',
      system: [],
      messages: [{ role: 'user', text: 'x' }],
      output: { name: 'x', schema: (await import('zod')).z.object({}) },
      maxOutputTokens: 10,
    });
    expect(result.ok === false && result.error.code).toBe('budget_reached');

    const overview = AiUsageOverviewResponse.parse((await call('GET', '/api/admin/ai-usage', { token })).body);
    expect(overview.games.find((g) => g.game.id === gameId)?.ceiling.status).toBe('reached');
  });

  it('C4: failed calls (ok = 0) are counted apart from successful ones, with their kind (timeout, refusal, bad JSON)', async () => {
    await boot();
    const { gameId } = await newGame();
    record(gameId);
    record(gameId, { ok: false, failureReason: 'timeout: timeout', attempt: 1, costUsdMicros: 0 });
    record(gameId, { ok: false, failureReason: 'timeout: timeout', attempt: 2, costUsdMicros: 0 });
    record(gameId, { ok: false, failureReason: 'refusal: mock refusal', attempt: 1 });
    record(gameId, { ok: false, failureReason: 'invalid_json: unexpected token', attempt: 1 });
    record(gameId, { ok: false, failureReason: 'schema_mismatch: verdict, outcomes.0.secretNote', attempt: 2, purpose: 'gm_repair' });

    const usage = await gameUsage(gameId, await adminToken());
    expect(usage.totals).toMatchObject({ calls: 6, okCalls: 1, failedCalls: 5 });
    expect(usage.failures).toEqual([
      { kind: 'timeout', count: 2 },
      { kind: 'invalid_json', count: 1 },
      { kind: 'refusal', count: 1 },
      { kind: 'schema_mismatch', count: 1 },
    ]);
    expect(usage.byPurpose.find((p) => p.purpose === 'gm_repair')?.totals).toMatchObject({ calls: 1, okCalls: 0, failedCalls: 1 });
    // Only the kind leaves the server, never the detail (it can name fields of the GM's answer).
    expect(JSON.stringify(usage)).not.toMatch(/secretNote|verdict|unexpected token|mock refusal/);
  });

  it('C5: players, the game owner and the Human GM get 403; the dashboard carries no narration, names, karma or actions', async () => {
    await boot();
    const t = await startedTable(server!, true);
    server!.db.prepare('update character set karma = -42').run();

    // A real Mock turn, so the usage rows come from the AI GM loop itself.
    const clients: RoomClient[] = [];
    try {
      for (const seat of [t.a, t.b, t.c]) {
        const c = await openRoom(server!, { token: seat.token });
        clients.push(c);
        await c.waitFor(isReady);
      }
      const [a, b, c] = clients as [RoomClient, RoomClient, RoomClient];
      a.action('เดินดูตลาดอย่างระมัดระวัง', 'public');
      b.action('แอบหยิบเหรียญจากกระเป๋าพ่อค้า', 'secret');
      c.action('นั่งพักใต้ต้นไม้ใหญ่', 'public');
      // GEN-058 (Q-030): a game with a Human GM publishes the turn only after the GM approves it.
      await approveHeldTurn(call, t.gm!.token);
      for (const x of clients) await x.waitFor((m) => m.type === 'room' && m.phase === 'EOSORIA' && m.turn === 2);
    } finally {
      await Promise.all(clients.map((x) => x.close()));
    }
    const gameId = (server!.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    const rows = (server!.db.prepare('select count(*) as n from ai_usage where game_id = ?').get(gameId) as { n: number }).n;
    expect(rows, 'the Mock turn recorded AI usage').toBeGreaterThan(0);

    for (const who of [t.gm!, t.a, t.b, t.c]) {
      for (const path of ['/api/admin/ai-usage', `/api/admin/ai-usage/${gameId}`]) {
        const res = await call('GET', path, { token: who.token });
        expect(res.status, `${path} with a player / GM session`).toBe(403);
        expect(res.body).toMatchObject({ code: 'forbidden' });
      }
    }
    expect((await call('GET', '/api/admin/ai-usage')).status).toBe(403);

    const token = await adminToken();
    const detail = await gameUsage(gameId, token);
    expect(detail.totals.calls).toBe(rows);
    const overview = await call('GET', '/api/admin/ai-usage', { token });
    const texts = [
      ...(server!.db.prepare('select text from room_entry where game_id = ?').all(gameId) as { text: string }[]).map((r) => r.text),
      ...(server!.db.prepare('select text from phase_action where game_id = ?').all(gameId) as { text: string }[]).map((r) => r.text),
      ...[LIN, DARIN, MEKHA].flatMap((p) => [p.name, p.appearance, p.personality]),
      'นก',
      'บี',
      'ซี',
      'จีเอ็ม',
    ].filter((s) => s.trim().length >= 2);
    expect(texts.length).toBeGreaterThan(9);
    for (const body of [JSON.stringify(detail), JSON.stringify(overview.body)]) {
      for (const secret of texts) expect(body, `leaks "${secret}"`).not.toContain(secret);
      expect(body).not.toMatch(/karma|-42|reputation|secret/i);
    }
  });

  it('C6: a game with no call yet answers zeros and empty lists (the web shows an empty state); an unknown game is 404', async () => {
    await boot();
    const { gameId } = await newGame();
    const token = await adminToken();
    const usage = await gameUsage(gameId, token);
    expect(usage.totals.calls).toBe(0);
    expect(usage.byPurpose).toEqual([]);
    expect(usage.byPeriod).toEqual([]);
    expect(usage.failures).toEqual([]);
    expect(usage.ceiling).toMatchObject({ spentUsdMicros: 0, percent: 0, status: 'ok' });

    expect((await call('GET', '/api/admin/ai-usage/no-such-game', { token })).status).toBe(404);
  });

  it('C6: usage of a deleted game is still listed (name null), since it was paid for', async () => {
    await boot();
    record('deleted-game-id', { costUsdMicros: 1234 });
    const token = await adminToken();
    const overview = AiUsageOverviewResponse.parse((await call('GET', '/api/admin/ai-usage', { token })).body);
    expect(overview.games.find((g) => g.game.id === 'deleted-game-id')).toMatchObject({ game: { name: null }, totals: { costUsdMicros: 1234 } });
    expect((await gameUsage('deleted-game-id', token)).totals.calls).toBe(1);
  });

  it('C7: a new call shows up in the next request (no cache on the server)', async () => {
    await boot();
    const { gameId } = await newGame();
    const token = await adminToken();
    record(gameId);
    expect((await gameUsage(gameId, token)).totals.calls).toBe(1);
    clock += 60_000; // inside the admin token's hour
    record(gameId);
    const next = await gameUsage(gameId, token);
    expect(next.totals.calls).toBe(2);
    expect(new Date(next.generatedAt).getTime()).toBe(clock);
  });

  it('C8: a model without a price counts its tokens but its cost is unknown, not 0', async () => {
    await boot();
    const { gameId } = await newGame();
    record(gameId, { costUsdMicros: 3000 });
    record(gameId, { model: 'mystery-model-9', tokens: { inputTokens: 4000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 400 }, costUsdMicros: 0 });

    const usage = await gameUsage(gameId, await adminToken());
    expect(usage.totals).toMatchObject({ calls: 2, inputTokens: 5000, outputTokens: 500, costUsdMicros: 3000, unpricedCalls: 1 });
    const models = Object.fromEntries(usage.byModel.map((m) => [m.model, m]));
    expect(models['mystery-model-9']).toMatchObject({ priced: false, totals: { inputTokens: 4000, unpricedCalls: 1 } });
    expect(models['claude-sonnet-5-5']).toMatchObject({ priced: true, totals: { unpricedCalls: 0 } });
  });
});
