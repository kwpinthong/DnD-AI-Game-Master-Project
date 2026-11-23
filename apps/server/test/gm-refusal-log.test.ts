import { AiUsageGameResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiCallResult, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import type { TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { gameRefusals, recordRefusal, REFUSAL_KEEP, REFUSAL_PROPOSAL_CHARS, REFUSAL_TEXT } from '../src/gm/refusal-log.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, startedTable, type Table } from './visibility-fixture.ts';

/**
 * GEN-199: the AI's answer the server refused (before the repair) is kept, scrubbed (tokens for names, player text
 * cut short), with each error's path, the value the AI gave and the message that names the expected value; the
 * server owner reads it on the game's AI usage page (admin only). The table keeps the newest REFUSAL_KEEP rows.
 */

const ADMIN_CODE = 'เจ้าของเซิร์ฟเวอร์-ทดสอบ-199';
const PLAYER_CODE = 'nok-code-2026';
const LOBBY = 'ล็อบบี้เจ้าของเกม';
const LONG_TEXT = 'แอบเดินไปหลังโรงเตี๊ยมแล้วค่อย ๆ เปิดประตูเก็บของ '.repeat(3); // > REFUSAL_TEXT (100), ≤ PLAYER_TEXT_MAX (ISK-012)

type Handler = (req: AiCallRequest) => AiCallResult | undefined;

describe('GEN-199 refused AI answers kept for the server owner', { timeout: 60_000 }, () => {
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

  async function boot(handler: Handler) {
    const provider: AiProvider = {
      id: 'mock',
      ready: () => ({ ok: true }),
      estimateTokens: (text) => Math.ceil(text.length / 3),
      async call(req) {
        const scripted = handler(req);
        if (scripted) return scripted.ok ? { ...scripted, model: req.model } : scripted;
        return mockReply.ok(await cannedGmAnswer(req));
      },
    };
    // startTestServer's config plus the admin code hash.
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }), aiLog: () => {}, rng: null },
    );
  }

  /** Every player acts once; resolves when turn 2 opens. */
  async function playTurn(t: Table, texts: string[]) {
    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(texts[i]!, 'public');
      await c.waitFor((m) => m.type === 'action_accepted', from);
    }
    for (const c of clients) await c.waitFor((m) => m.type === 'room' && m.turn === 2 && m.status === 'collecting');
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;

  async function adminReport(t: Table) {
    const session = await t.call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    const token = (session.body as { token: string }).token;
    const res = await t.call('GET', `/api/admin/ai-usage/${gameIdOf(t)}`, { token });
    expect(res.status).toBe(200);
    return AiUsageGameResponse.parse(res.body);
  }

  /** The first adjudicate answer: action 0 costs 7 Stamina (in range, wrong for its kind) (and `edit` may add more); the repair gets the Mock's valid answer. */
  const wrongStamina =
    (edit: (proposal: ReturnType<typeof mockTurnProposal>, ctx: TurnContext) => void = () => {}): Handler =>
    (req) => {
      if (req.purpose !== 'gm_adjudicate') return undefined;
      const ctx = contextOf<TurnContext>(req);
      const proposal = mockTurnProposal(ctx);
      for (const a of proposal.actions) a.check = { type: 'none' };
      proposal.actions[0]!.staminaCost = 7;
      edit(proposal, ctx);
      return mockReply.ok(proposal);
    };

  it('C1: a stamina_cost_mismatch repair keeps the value the AI gave, the expected value and the path', async () => {
    await boot(wrongStamina());
    const t = await startedTable(server!, false);
    await playTurn(t, ['เดินดูรอบ ๆ', 'นั่งฟังข่าว', 'ล้างแก้ว']);

    const { refusals } = await adminReport(t);
    expect(refusals).toHaveLength(1);
    const r = refusals[0]!;
    expect(r).toMatchObject({ purpose: 'gm_adjudicate', stage: 'first' });
    const error = r.errors.find((e) => e.code === 'stamina_cost_mismatch');
    expect(error, JSON.stringify(r.errors)).toMatchObject({ path: 'actions[0].staminaCost', got: '7' });
    expect(error!.message).toMatch(/costs \d+(\.\.\d+)?, got 7/);
    expect(JSON.parse(r.proposal).actions[0].staminaCost).toBe(7);
  });

  it('C2: the kept answer has no real name, lobby name or player code, and player text is cut short', async () => {
    let npcName = '';
    await boot(
      wrongStamina((proposal, ctx) => {
        const action = ctx.actions.find((a) => a.text.startsWith('แอบ'))!;
        proposal.actions[0]!.reason = `${LIN.name} ${DARIN.name} ${MEKHA.name} ${LOBBY} ${npcName} ${action.text}`.slice(0, 300);
        proposal.actions[1]!.intentSummary = action.text.slice(0, 200);
      }),
    );
    const t = await startedTable(server!, false, { name: LOBBY, playerCode: PLAYER_CODE });
    npcName = getGameScenario(server!.orm, gameIdOf(t))!.npcs[0]!.name;
    await playTurn(t, [LONG_TEXT, 'นั่งฟังข่าว', 'ล้างแก้ว']);

    const { refusals } = await adminReport(t);
    expect(refusals).toHaveLength(1);
    const kept = JSON.stringify(refusals);
    for (const secret of [LIN.name, DARIN.name, MEKHA.name, LOBBY, npcName, PLAYER_CODE, PLAYER_CODE.toUpperCase(), LONG_TEXT.trim()]) {
      expect(kept).not.toContain(secret);
    }
    const strings: string[] = [];
    JSON.parse(refusals[0]!.proposal, (_k, v: unknown) => (typeof v === 'string' && strings.push(v), v));
    expect(Math.max(...strings.map((s) => s.length))).toBeLessThanOrEqual(REFUSAL_TEXT + 1);
    // The row in the DB is the same scrubbed text (nothing richer is stored).
    const raw = JSON.stringify(server!.db.prepare('select * from gm_refusal').all());
    for (const secret of [LIN.name, LOBBY, npcName, PLAYER_CODE, LONG_TEXT.trim()]) expect(raw).not.toContain(secret);
  });

  it('C3: only an admin token reads the refusals: a player, the game owner or no token gets 403', async () => {
    await boot(wrongStamina());
    const t = await startedTable(server!, false);
    await playTurn(t, ['เดินดูรอบ ๆ', 'นั่งฟังข่าว', 'ล้างแก้ว']);
    const path = `/api/admin/ai-usage/${gameIdOf(t)}`;
    for (const token of [t.a.token, t.b.token, undefined]) {
      const res = await t.call('GET', path, token ? { token } : {});
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('stamina_cost_mismatch');
    }
    expect((await adminReport(t)).refusals).toHaveLength(1);
  });

  it('cap: the table keeps the newest rows only and each answer is cut to its size limit', async () => {
    await boot(() => undefined);
    const db = server!.orm;
    const big = { actions: Array.from({ length: 200 }, (_, i) => ({ actionId: `act-${i}`, reason: 'ก'.repeat(90) })) };
    for (let i = 0; i < REFUSAL_KEEP + 5; i++) {
      recordRefusal(db, { gameId: 'g1', purpose: 'gm_adjudicate', stage: 'first', value: big, errors: [{ code: 'x', path: `actions[${i % 200}].reason`, message: 'm' }], at: i });
    }
    expect((server!.db.prepare('select count(*) as n from gm_refusal').get() as { n: number }).n).toBe(REFUSAL_KEEP);
    const list = gameRefusals(db, 'g1');
    expect(list[0]!.proposal.length).toBeLessThanOrEqual(REFUSAL_PROPOSAL_CHARS);
    expect(list[0]!.at).toBe(new Date(REFUSAL_KEEP + 4).toISOString());
  });
});
