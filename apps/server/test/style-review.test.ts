import { AdminCorrectionsExportResponse, AiUsageOverviewResponse, StyleReviewResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest } from '../src/ai/provider.ts';
import { createMockProvider, type MockProvider } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import { gateStyle, recordStyleFlags, setStyleSettings, styleIssues, type StyleIssue } from '../src/gm/style-check.ts';
import { insertEntry } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, startedTable, type Table } from './visibility-fixture.ts';

/**
 * GEN-178: the style review round. Every 5 ended games (or "run now" in /admin) the server counts the new 👎 (with
 * their reason chips) and style flags since the last round; under 20 it skips, otherwise one `style_review` AI call
 * proposes rules for the Voice data set, which change nothing until the server owner approves each one.
 */
const ADMIN_CODE = 'ทดสอบ-ทบทวนสำนวน-178';
const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;
const GAME_NAME = 'เมืองก่อนอุกกาบาต';
const SECRET = 'ความลับของผู้เล่นห้ามหลุด';

const FORBID_THAM_KAN = { id: 'tham_kan', match: { type: 'literal', value: 'ทำการ' }, scope: 'all', severity: 'block', fix: 'ตัด ทำการ ใช้กริยาตรง' };
const PAIR = { bad: 'เขามีความโกรธ', good: 'เขาโกรธ' };

describe('GEN-178 style review round', { timeout: 120_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let provider: MockProvider;
  let clock = CLOCK;
  let logs: string[] = [];
  /** What the mock answers a `style_review` call; a function so a test can change it between rounds. */
  let answer: () => unknown = () => ({ patterns: [], proposals: [] });

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    clock = CLOCK;
    logs = [];
    answer = () => ({ patterns: [], proposals: [] });
    const config = loadAiConfig({ AI_PROVIDER: 'mock', AI_RETRY_DELAY_MS: '0' });
    provider = createMockProvider(config, undefined, (req: AiCallRequest) => (req.purpose === 'style_review' ? answer() : undefined));
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${tmp.dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => clock, ai: config, aiProvider: provider, aiLog: (line) => logs.push(line), rng: null },
    );
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const tick = () => (clock += 1_000);
  const reviewCalls = () => provider.requests.filter((r) => r.purpose === 'style_review');

  async function seeded() {
    const t = await startedTable(server!, false);
    const gameId = (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const everyone = [t.a.memberId, t.b.memberId, t.c.memberId];
    const npc = getGameScenario(server!.orm, gameId)!.npcs[0]!;
    const admin = ((await t.call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body as { token: string }).token;
    let n = 0;
    /** One AI message with a 👎 from player A (with `reasons`); NPC lines name a player and the NPC by their real names. */
    async function downvoted(reasons: string[], asNpc: boolean) {
      n += 1;
      const seq = asNpc
        ? insertEntry(server!.orm, gameId, { kind: 'npc', meta: { npc: { id: npc.id, kind: 'dialogue' } }, at, locationId: null, text: `${LIN.name} ฟังนะ ${npc.name} บอกครั้งที่ ${n}` }, everyone, clock).id
        : insertEntry(server!.orm, gameId, { kind: 'narration', at, locationId: null, text: `${DARIN.name} ได้ทำการเดินเข้าเมือง ครั้งที่ ${n}` }, everyone, clock).id;
      const res = await t.call('PUT', `/api/game/entries/${seq}/vote`, { token: t.a.token, body: { vote: 'down', reasons } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return seq;
    }
    return { t, gameId, npc, admin, everyone, downvoted };
  }

  /** 12 👎 (6 NPC lines, 6 narrations) + 15 flags (10 narration ทำการ, 5 NPC pronoun). */
  async function twentySeven(s: Awaited<ReturnType<typeof seeded>>) {
    for (let i = 0; i < 6; i++) await s.downvoted(i < 4 ? ['out_of_character'] : ['too_long', 'translation'], true);
    for (let i = 0; i < 6; i++) await s.downvoted(['wrong_story'], false);
    const issues: StyleIssue[] = [
      ...Array.from({ length: 10 }, (): StyleIssue => ({ reason: 'dai_tham_kan', severity: 'block', npcId: null, fix: '' })),
      ...Array.from({ length: 5 }, (): StyleIssue => ({ reason: 'pronoun_mismatch', severity: 'flag', npcId: s.npc.id, fix: '' })),
    ];
    recordStyleFlags(server!.orm, issues);
  }

  const state = async (t: Table, token: string) => {
    const res = await t.call('GET', '/api/admin/style-review', { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return StyleReviewResponse.parse(res.body);
  };

  /** "Run now" in /admin, then waits for the round to finish. */
  async function runNow(t: Table, token: string) {
    const res = await t.call('POST', '/api/admin/style-review/run', { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    let last: StyleReviewResponse | undefined;
    await vi.waitFor(async () => {
      last = await state(t, token);
      expect(last.running).toBe(false);
    });
    tick();
    return last!;
  }

  it('R1 / R5: "run now" with 27 new signals counts them by chip, rule id and NPC; without the admin code 403', async () => {
    const s = await seeded();
    await twentySeven(s);
    tick();
    for (const token of [undefined, s.t.a.token]) {
      expect((await s.t.call('POST', '/api/admin/style-review/run', token ? { token } : {})).status).toBe(403);
      expect((await s.t.call('GET', '/api/admin/style-review', token ? { token } : {})).status).toBe(403);
    }
    expect(reviewCalls()).toHaveLength(0);

    const waiting = (await state(s.t, s.admin)).waiting;
    expect(waiting).toMatchObject({ downvotes: 12, flags: 15 });

    const after = await runNow(s.t, s.admin);
    const round = after.rounds[0]!;
    expect(round).toMatchObject({ trigger: 'manual', status: 'done', signals: 27 });
    expect(round.counts).toEqual({
      downvotes: 12,
      flags: 15,
      reasons: { out_of_character: 4, too_long: 2, translation: 2, wrong_story: 6 },
      rules: { dai_tham_kan: 10, pronoun_mismatch: 5 },
      npcs: { [s.npc.id]: 11, '': 16 },
    });
    expect(reviewCalls()).toHaveLength(1);
  });

  it('R2 / R3: used signals are not counted again; 19 new ones skip the round with no AI call and wait for the next', async () => {
    const s = await seeded();
    await twentySeven(s);
    tick();
    await runNow(s.t, s.admin);
    expect(reviewCalls()).toHaveLength(1);

    // Nothing new: skipped.
    const empty = await runNow(s.t, s.admin);
    expect(empty.rounds[0]).toMatchObject({ status: 'skipped', signals: 0 });

    for (let i = 0; i < 9; i++) await s.downvoted(['too_long'], false);
    recordStyleFlags(server!.orm, Array.from({ length: 10 }, (): StyleIssue => ({ reason: 'loanword', severity: 'flag', npcId: null, fix: '' })));
    tick();
    const skipped = await runNow(s.t, s.admin);
    expect(skipped.rounds[0]).toMatchObject({ status: 'skipped', signals: 19 });
    expect(reviewCalls()).toHaveLength(1);
    expect(skipped.waiting).toMatchObject({ downvotes: 9, flags: 10 });

    // One more: the 19 waited and now go with it (20), never the 27 of the first round.
    await s.downvoted(['other'], true);
    tick();
    const next = await runNow(s.t, s.admin);
    expect(next.rounds[0]).toMatchObject({ status: 'done', signals: 20 });
    expect(next.rounds[0]!.counts.rules).toEqual({ loanword: 10 });
    expect(reviewCalls()).toHaveLength(2);
    expect(next.waiting).toMatchObject({ downvotes: 0, flags: 0 });
  });

  it('R4: the 5th ended game since the last round starts one round; the 4th does not', async () => {
    const s = await seeded();
    await twentySeven(s);
    tick();
    for (const id of ['g1', 'g2', 'g3', 'g4']) await server!.styleReview.gameEnded(id);
    // The same game ending twice counts once.
    await server!.styleReview.gameEnded('g4');
    expect((await state(s.t, s.admin)).rounds).toEqual([]);
    expect((await state(s.t, s.admin)).gamesSinceRound).toBe(4);
    await server!.styleReview.gameEnded('g5');
    const after = await state(s.t, s.admin);
    expect(after.rounds).toHaveLength(1);
    expect(after.rounds[0]).toMatchObject({ trigger: 'games', status: 'done', signals: 27 });
    expect(after.gamesSinceRound).toBe(0);
    expect(reviewCalls()).toHaveLength(1);
  });

  it('R6: the AI sees only AI messages, with names swapped for tokens; no lobby name, invite code or GM-only text', async () => {
    const s = await seeded();
    await twentySeven(s);
    // Not AI-written (a player's own line) and a fallback narration: never shown to the reviewer, even with a 👎 row.
    const own = insertEntry(server!.orm, s.gameId, { kind: 'player', at, locationId: null, text: SECRET }, s.everyone, clock).id;
    const fallback = insertEntry(server!.orm, s.gameId, { kind: 'narration', at, locationId: null, text: `${SECRET} สำรอง`, fallback: 'timeout' }, s.everyone, clock).id;
    for (const seq of [own, fallback]) {
      server!.db.prepare("insert into response_vote (game_id, member_id, source_ref, vote, updated_at, reasons) values (?, ?, ?, 'down', ?, '[]')").run(s.gameId, s.t.b.memberId, `entry-${seq}`, clock);
    }
    tick();
    await runNow(s.t, s.admin);
    const [req] = reviewCalls();
    const input = JSON.stringify([req!.system, req!.messages]);
    const inviteCode = (server!.db.prepare('select invite_code as code from game where id = ?').get(s.gameId) as { code: string }).code;
    for (const leak of [LIN.name, DARIN.name, MEKHA.name, s.npc.name, GAME_NAME, inviteCode, SECRET, 'gmNote', 'saga', 'journal']) expect(input).not.toContain(leak);
    expect(input).toContain(`{{n:${s.npc.id}}}`);
    expect(input).toContain('{{p:player}}');
    expect(input).toContain('ได้ทำการเดินเข้าเมือง');
  });

  it('R7 / R8 / R10: of 3 proposals 1 breaks the schema (logged, dropped); nothing changes the Voice until approved; a reject changes nothing', async () => {
    const s = await seeded();
    await twentySeven(s);
    answer = () => ({
      patterns: [{ summary: 'บรรยายใช้ ทำการ บ่อย', evidence: [1, 2] }],
      proposals: [
        { kind: 'forbid', npcId: null, content: FORBID_THAM_KAN, reason: 'เจอบ่อย', evidence: [1] },
        { kind: 'forbid', npcId: null, content: { ...FORBID_THAM_KAN, id: 'bad_rule', severity: 'banned' }, reason: 'ผิด schema', evidence: [] },
        { kind: 'pair', npcId: null, content: PAIR, reason: 'ตัด มีความ', evidence: [2] },
      ],
    });
    const before = server!.assets.voice;
    tick();
    const after = await runNow(s.t, s.admin);
    expect(after.rounds[0]!.patterns).toEqual([{ summary: 'บรรยายใช้ ทำการ บ่อย', evidence: [1, 2] }]);
    expect(after.proposals.map((p) => [p.kind, p.status])).toEqual([
      ['forbid', 'proposed'],
      ['pair', 'proposed'],
    ]);
    const bad = logs.find((l) => l.startsWith('[style-review]') && l.includes('dropped'));
    expect(bad).toMatch(/proposal 2/);
    expect(bad).not.toContain('banned');

    // R8: not approved yet → the next turn reads the same Voice version and rules.
    expect(server!.assets.voice.version).toBe(before.version);
    expect(server!.assets.voice.forbidden).toEqual(before.forbidden);
    expect(after.voice.version).toBe(before.version);

    // R10: reject → no new version.
    const pair = after.proposals.find((p) => p.kind === 'pair')!;
    expect((await s.t.call('POST', `/api/admin/style-review/proposals/${pair.id}/reject`, { token: s.t.a.token })).status).toBe(403);
    const rejected = await s.t.call('POST', `/api/admin/style-review/proposals/${pair.id}/reject`, { token: s.admin });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(StyleReviewResponse.parse(rejected.body).proposals.find((p) => p.id === pair.id)!.status).toBe('rejected');
    expect(server!.assets.voice.version).toBe(before.version);
    expect(server!.assets.voice.pairs).toEqual(before.pairs);
    // A decided proposal cannot be decided again.
    expect((await s.t.call('POST', `/api/admin/style-review/proposals/${pair.id}/approve`, { token: s.admin, body: {} })).status).toBe(409);
    expect((await s.t.call('POST', '/api/admin/style-review/proposals/9999/approve', { token: s.admin, body: {} })).status).toBe(404);
  });

  it('R9 / R11: an approved "ทำการ" rule is in the next call and the checker; versions roll back and stay in history', async () => {
    const s = await seeded();
    // A Voice without the shipped ทำการ rule, so the approved one is the only one.
    const voice = (await s.t.call('GET', '/api/admin/game-data/Voice', { token: s.admin })).body as { value: { forbidden: { id: string }[] } };
    const saved = await s.t.call('PUT', '/api/admin/game-data/Voice', { token: s.admin, body: { value: { ...voice.value, forbidden: voice.value.forbidden.filter((r) => r.id !== 'dai_tham_kan') } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(styleIssues(server!.assets.voice, 'เขาได้ทำการเปิดประตู', 'narration')).toEqual([]);
    expect(server!.assets.voice.version).toBe(1);

    await twentySeven(s);
    answer = () => ({
      patterns: [],
      proposals: [
        { kind: 'forbid', npcId: null, content: FORBID_THAM_KAN, reason: 'เจอบ่อย', evidence: [] },
        { kind: 'pair', npcId: null, content: PAIR, reason: 'ตัด มีความ', evidence: [] },
      ],
    });
    tick();
    const round = await runNow(s.t, s.admin);
    const [forbid, pair] = round.proposals;

    const approved = await s.t.call('POST', `/api/admin/style-review/proposals/${forbid!.id}/approve`, { token: s.admin, body: {} });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const v2 = StyleReviewResponse.parse(approved.body);
    expect(v2.voice.version).toBe(2);
    expect(v2.proposals.find((p) => p.id === forbid!.id)).toMatchObject({ status: 'approved', voiceVersion: 2 });
    expect(server!.assets.voice.version).toBe(2);
    expect(styleIssues(server!.assets.voice, 'เขาได้ทำการเปิดประตู', 'narration').map((i) => i.reason)).toContain('tham_kan');

    // The next AI call: a block hit's rewrite prompt carries the new rule and its fix.
    setStyleSettings(server!.orm, { rewrite: true });
    let asked: StyleIssue[] = [];
    await gateStyle({
      db: server!.orm,
      value: { text: 'เขาได้ทำการเปิดประตู' },
      issuesOf: (v) => styleIssues(server!.assets.voice, v.text, 'narration'),
      timeoutMs: 1_000,
      rewrite: async (issues) => ((asked = issues), { text: 'เขาผลักประตูเปิด' }),
    });
    expect(asked).toEqual([expect.objectContaining({ reason: 'tham_kan', fix: FORBID_THAM_KAN.fix })]);

    // Edit then approve: the pair goes in as edited → version 3.
    const edited = { bad: 'เขามีความสุข', good: 'เขาสุขใจ' };
    const v3 = StyleReviewResponse.parse((await s.t.call('POST', `/api/admin/style-review/proposals/${pair!.id}/approve`, { token: s.admin, body: { content: edited } })).body);
    expect(v3.voice.version).toBe(3);
    expect(server!.assets.voice.pairs).toContainEqual(edited);
    expect(v3.voice.versions.map((v) => v.version)).toEqual(expect.arrayContaining([1, 2, 3]));

    // R11: back to version 2 → the next call reads 2; 3 stays in the history.
    expect((await s.t.call('POST', '/api/admin/style-review/voice/2/restore', { token: s.t.a.token })).status).toBe(403);
    const back = await s.t.call('POST', '/api/admin/style-review/voice/2/restore', { token: s.admin });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const restored = StyleReviewResponse.parse(back.body);
    expect(server!.assets.voice.version).toBe(2);
    expect(server!.assets.voice.pairs).not.toContainEqual(edited);
    expect(restored.voice.version).toBe(2);
    expect(restored.voice.versions.map((v) => v.version)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(restored.voice.versions.find((v) => v.current)!.version).toBe(2);
    expect((await s.t.call('POST', '/api/admin/style-review/voice/99/restore', { token: s.admin })).status).toBe(404);
  });

  it('R12 / R14: an edited AI message is one GEN-168 pair, in the GEN-151 library at once; it outlives its game and exports', async () => {
    const s = await seeded();
    const seq = await s.downvoted(['out_of_character'], true);
    const saved = await s.t.call('POST', '/api/admin/corrections', { token: s.admin, body: { gameId: s.gameId, seq, edited: 'ข้าเตือนแล้วนะ', toLibrary: true } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const pairs = server!.db.prepare('select original, edited from response_correction').all() as { original: string; edited: string }[];
    expect(pairs).toEqual([{ original: expect.stringContaining('บอกครั้งที่ 1'), edited: 'ข้าเตือนแล้วนะ' }]);
    expect(server!.db.prepare("select count(*) as n from sqlite_master where name = 'style_edit_pair'").get()).toEqual({ n: 0 });
    expect(server!.db.prepare("select source, text from npc_example").all()).toEqual([{ source: 'correction', text: 'ข้าเตือนแล้วนะ' }]);

    // R14: the game is deleted; the pair stays and the export has it.
    server!.db.prepare('delete from game where id = ?').run(s.gameId);
    expect(server!.db.prepare('select count(*) as n from room_entry where game_id = ?').get(s.gameId)).toEqual({ n: 0 });
    const out = AdminCorrectionsExportResponse.parse((await s.t.call('GET', '/api/admin/corrections-export', { token: s.admin })).body);
    expect(out.count).toBe(1);
    expect(JSON.parse(out.jsonl.trim())).toMatchObject({ edited: 'ข้าเตือนแล้วนะ', scene: 'npc-dialogue' });
  });

  it('R13: an NPC line most players liked (voteVerdict good) is a library candidate once, and leaves the list when added', async () => {
    const s = await seeded();
    const say = (text: string) => insertEntry(server!.orm, s.gameId, { kind: 'npc', meta: { npc: { id: s.npc.id, kind: 'dialogue' } }, at, locationId: null, text }, s.everyone, clock).id;
    const liked = say('บทที่คนชอบ');
    const once = say('บทที่ชอบคนเดียว');
    for (const who of [s.t.a, s.t.b]) await s.t.call('PUT', `/api/game/entries/${liked}/vote`, { token: who.token, body: { vote: 'up' } });
    await s.t.call('PUT', `/api/game/entries/${once}/vote`, { token: s.t.a.token, body: { vote: 'up' } });

    const before = await state(s.t, s.admin);
    expect(before.goodCandidates).toEqual([{ gameId: s.gameId, seq: liked, npc: { id: s.npc.id, name: s.npc.name }, text: 'บทที่คนชอบ', up: 2 }]);
    const added = await s.t.call('POST', '/api/admin/npc-library', { token: s.admin, body: { from: 'vote', gameId: s.gameId, seq: liked, npcId: s.npc.id, scene: 'npc-dialogue' } });
    expect(added.status).toBe(200);
    expect((await state(s.t, s.admin)).goodCandidates).toEqual([]);
  });

  it('R15: a round is one ai_usage row of purpose style_review with tokens and cost on the usage page', async () => {
    const s = await seeded();
    await twentySeven(s);
    tick();
    await runNow(s.t, s.admin);
    const usage = AiUsageOverviewResponse.parse((await s.t.call('GET', '/api/admin/ai-usage', { token: s.admin })).body);
    const row = usage.byPurpose.find((p) => p.purpose === 'style_review');
    expect(row?.totals).toMatchObject({ calls: 1, okCalls: 1 });
    expect(row!.totals.inputTokens).toBeGreaterThan(0);
    expect(row!.totals.costUsdMicros).toBeGreaterThan(0);
  });

  it('R16: an AI failure marks the round failed with no proposals; the signals wait and a retry succeeds', async () => {
    const s = await seeded();
    await twentySeven(s);
    answer = () => ({ proposals: 'not a list' });
    tick();
    const failed = await runNow(s.t, s.admin);
    expect(failed.rounds[0]).toMatchObject({ status: 'failed', signals: 27 });
    expect(failed.rounds[0]!.error).toBeTruthy();
    expect(failed.proposals).toEqual([]);
    expect(failed.waiting).toMatchObject({ downvotes: 12, flags: 15 });

    answer = () => ({ patterns: [], proposals: [{ kind: 'pair', npcId: null, content: PAIR, reason: 'ตัด มีความ', evidence: [] }] });
    const retried = await runNow(s.t, s.admin);
    expect(retried.rounds[0]).toMatchObject({ status: 'done', signals: 27 });
    expect(retried.proposals).toHaveLength(1);
  });
});
