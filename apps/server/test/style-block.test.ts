import { AdminSessionResponse, type RoomServerMessage } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { loadGameAssets } from '../src/assets/load.ts';
import type { VoiceAsset } from '../src/assets/voice.ts';
import { hashPin } from '../src/auth/pin.ts';
import { estimateTokens } from '../src/gm/context.ts';
import { cannedGmAnswer } from '../src/gm/mock-gm.ts';
import { STYLE_BLOCK_TOKENS, styleBlock } from '../src/gm/tone.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call, type Table } from './visibility-fixture.ts';

// GEN-195: the Voice's forbidden phrases + bad→good pairs in the stable (cached) start of every narration and
// dialogue prompt, right after the tone block, within a token budget.

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-คู่มือสำนวน-195';

const isNarration = (r: AiCallRequest) => r.output.name === 'gm_narration';
const isDialogue = (r: AiCallRequest) => r.output.name === 'gm_dialogue';
const styleOf = (r: AiCallRequest) => r.system.find((b) => b.id === 'style');

const voice = loadGameAssets().voice;

describe('style block (GEN-195), unit', () => {
  it('C1: narration gets the all + narration rules and every pair; dialogue the all + dialogue rules', () => {
    const narration = styleBlock(voice, 'narration');
    const dialogue = styleBlock(voice, 'dialogue');
    expect(narration.cache).toBe(true);
    expect(dialogue.cache).toBe(true);
    for (const rule of voice.forbidden) {
      if (rule.scope !== 'dialogue') expect(narration.text, rule.id).toContain(rule.fix);
      if (rule.scope !== 'narration') expect(dialogue.text, rule.id).toContain(rule.fix);
    }
    // The narration-only rules (pronoun density, loan words) stay out of the dialogue block.
    expect(dialogue.text).not.toContain('ละประธาน หรือใช้คำเรียกตามรูปลักษณ์');
    expect(dialogue.text).not.toContain('โอเค|เช็ค');
    for (const p of voice.pairs) {
      expect(narration.text).toContain(`${p.bad} → ${p.good}`);
      expect(dialogue.text).toContain(`${p.bad} → ${p.good}`);
    }
    expect(narration.text).toContain('(ได้)?ทำการ');
  });

  it('C3: the same Voice gives the same bytes', () => {
    expect(JSON.stringify(styleBlock(voice, 'narration'))).toBe(JSON.stringify(styleBlock(voice, 'narration')));
  });

  it('C4: voice.json is within the budget (before: no block = 0 tokens)', () => {
    for (const scope of ['narration', 'dialogue'] as const) {
      const tokens = estimateTokens(styleBlock(voice, scope).text);
      console.log(`[GEN-195] style block ${scope}: ${tokens} / ${STYLE_BLOCK_TOKENS} tokens`);
      expect(tokens).toBeLessThanOrEqual(STYLE_BLOCK_TOKENS);
    }
  });

  it('C4: a Voice too big for the budget is cut to it, pairs first, block rules always kept', () => {
    const long = 'ก'.repeat(110);
    const big: VoiceAsset = {
      ...voice,
      forbidden: [
        ...Array.from({ length: 38 }, (_, i) => ({ id: `flag_${i}`, match: { type: 'literal' as const, value: `คำต้องห้าม${i}` }, scope: 'all' as const, severity: 'flag' as const, fix: long })),
        { id: 'late_block', match: { type: 'literal', value: 'บล็อกท้าย' }, scope: 'all', severity: 'block', fix: 'ห้ามเด็ดขาด' },
      ],
      pairs: Array.from({ length: 15 }, (_, i) => ({ bad: `${long}${i}`, good: `${long}${i}` })),
    };
    const text = styleBlock(big, 'narration').text;
    expect(estimateTokens(text)).toBeLessThanOrEqual(STYLE_BLOCK_TOKENS);
    expect(text).toContain('บล็อกท้าย');
    expect(text).toContain('คำต้องห้าม0');
    expect(text).not.toContain(' → ');
    // Whole lines only: no rule cut in the middle.
    for (const line of text.split('\n')) if (line.includes('คำต้องห้าม')) expect(line).toContain(long);
  });
});

describe('style block (GEN-195), in the prompts', { timeout: 90_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer;
  let call: Call;
  const requests: AiCallRequest[] = [];
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    requests.length = 0;
    const provider: AiProvider = {
      id: 'mock',
      ready: () => ({ ok: true }),
      estimateTokens: (text) => Math.ceil(text.length / 3),
      async call(req) {
        requests.push(req);
        return { ...mockReply.ok(await cannedGmAnswer(req)), model: req.model };
      },
    };
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }), aiProvider: provider, aiLog: () => {}, rng: null },
    );
    call = caller(server);
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server.close();
    cleanup();
  });

  const gameIdOf = (t: Table) => (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;

  /** A and B at the fountain (NPCs there speak), one turn played; returns once the dialogue calls are in. */
  async function playAtFountain(t: Table, turn: 1 | 2 = 1) {
    if (turn === 1) {
      for (const who of [t.a, t.b]) expect(moveCharacter(server.orm, who.memberId, 'fountain', CLOCK)).toBe(true);
      const gameId = gameIdOf(t);
      savePhaseState(server.orm, gameId, { ...ensurePhaseState(server.orm, gameId, CLOCK), day: 1, phase: 'SOLARION', turn: 1 }, CLOCK);
    }
    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      clients.push(c);
    }
    const dialogues = requests.filter(isDialogue).length;
    const starts = clients.map((c) => c.messages.length);
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(['ทักทายเด็กขอทาน', 'มองน้ำพุ', 'ล้างแก้ว'][i]!, 'public');
      await c.waitFor((m) => m.type === 'action_accepted', from);
    }
    const next = (m: RoomServerMessage) => m.type === 'room' && m.status === 'collecting' && (turn === 1 ? m.turn === 2 : m.turn === 1);
    for (const [i, c] of clients.entries()) await c.waitFor(next, starts[i]);
    for (const end = Date.now() + 3_000; requests.filter(isDialogue).length === dialogues && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    await Promise.all(sockets.splice(0).map((s) => s.close()));
  }

  it('C1: the narration and dialogue prompts carry the rules, cached, right after the tone block', async () => {
    const t = await startedTable(server, false);
    await playAtFountain(t);
    const narration = requests.filter(isNarration);
    const dialogue = requests.filter(isDialogue);
    expect(narration.length).toBeGreaterThan(0);
    expect(dialogue.length).toBeGreaterThan(0);
    for (const r of [...narration, ...dialogue]) {
      const ids = r.system.map((b) => b.id);
      expect(ids.indexOf('style')).toBe(ids.indexOf('tone') + 1);
      expect(styleOf(r)!.cache).toBe(true);
      expect(styleOf(r)!.text).toContain('ตัด ทำการ ใช้กริยาตรง');
      expect(styleOf(r)!.text).toContain('เขาได้ทำการเปิดประตูออก → เขาผลักประตูเปิด');
      expect(JSON.stringify(r.messages)).not.toContain('เขาผลักประตูเปิด');
    }
  });

  it('C2: a rule Nok approves in the style review is in the next call', async () => {
    const t = await startedTable(server, false);
    await playAtFountain(t, 1);
    for (const r of requests.filter(isNarration)) expect(styleOf(r)!.text).not.toContain('ห้ามใช้คำว่าบังเกิด');
    const token = AdminSessionResponse.parse((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body).token;
    const round = server.db
      .prepare("insert into style_review_round (trigger, status, signals, counts, to_at, flag_snapshot, created_at) values ('manual', 'done', 20, ?, 0, '{}', 0)")
      .run(JSON.stringify({ downvotes: 20, flags: 0, reasons: {}, rules: {}, npcs: {} }));
    const rule = { id: 'bang_koed', match: { type: 'literal', value: 'บังเกิด' }, scope: 'all', severity: 'flag', fix: 'ห้ามใช้คำว่าบังเกิด' };
    const id = Number(server.db.prepare("insert into style_rule_proposal (round_id, kind, content, reason, status) values (?, 'forbid', ?, 'คำเก่า', 'proposed')").run(round.lastInsertRowid, JSON.stringify(rule)).lastInsertRowid);
    const approved = await call('POST', `/api/admin/style-review/proposals/${id}/approve`, { token, body: {} });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const before = requests.length;
    await playAtFountain(t, 2);
    const after = requests.slice(before).filter(isNarration);
    expect(after.length).toBeGreaterThan(0);
    for (const r of after) expect(styleOf(r)!.text).toContain('ห้ามใช้คำว่าบังเกิด');
  });

  it('C3: two calls in a row start byte-identical, the style block included', async () => {
    const t = await startedTable(server, false);
    await playAtFountain(t, 1);
    await playAtFountain(t, 2);
    const narration = requests.filter((r) => isNarration(r) && 'place' in (JSON.parse(r.messages[0]!.text) as { audience: object }).audience);
    expect(narration.length).toBeGreaterThanOrEqual(2);
    for (const r of narration.slice(1)) expect(JSON.stringify(r.system)).toBe(JSON.stringify(narration[0]!.system));
    const dialogue = requests.filter(isDialogue);
    expect(dialogue.length).toBeGreaterThanOrEqual(2);
    for (const r of dialogue.slice(1)) expect(JSON.stringify(r.system)).toBe(JSON.stringify(dialogue[0]!.system));
    expect(styleOf(dialogue[0]!)).toBeDefined();
  });
});
