import { AdminSessionResponse, ApiError, StyleEvalResponse } from '@isekai/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { createMockProvider } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import { narrationReport, npcReplyReport, runStyleEval, styleEvalView } from '../src/eval/style-eval.ts';
import { STYLE_SCENES, THAI_PURPOSES } from '../src/eval/style-scenes.ts';
import { cannedGmAnswer } from '../src/gm/mock-gm.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, type Call } from './visibility-fixture.ts';

// GEN-167: the fixed Thai style eval set, its runner and the admin side-by-side page (no real AI here: the Mock).

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-ชุดสำนวน-167';

describe('GEN-167 the eval set', () => {
  it('C1: 10-20 scenes, at least 5 NPCs, every purpose that writes Thai', () => {
    expect(STYLE_SCENES.length).toBeGreaterThanOrEqual(10);
    // ISK-026 (pending Nok's answer): 6 narration + 6 NPC chat + 6 turn-line scenes + the 3 summaries no longer fit in 20.
    expect(STYLE_SCENES.length).toBeLessThanOrEqual(23);
    expect(new Set(STYLE_SCENES.map((s) => s.id)).size).toBe(STYLE_SCENES.length);
    expect(new Set(STYLE_SCENES.flatMap((s) => s.npcs)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(STYLE_SCENES.map((s) => s.purpose))).toEqual(new Set(THAI_PURPOSES));
    // The fixtures are prompts as the game builds them: tokens only, never an NPC's real name.
    expect(JSON.stringify(STYLE_SCENES)).not.toMatch(/โนอา|ลูเซีย|การ์เร็ต|มาร์คัส|วิคเตอร์|เอเลน่า/);
  });

  it('C2: `pnpm eval:style` is the script that runs it', () => {
    const root = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const server = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(root.scripts['eval:style']).toContain('eval:style');
    expect(server.scripts['eval:style']).toContain('src/eval/style-eval-cli.ts');
  });
});

describe('GEN-167 runner and admin page', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer;
  let call: Call;
  const config = loadAiConfig({ AI_PROVIDER: 'mock' });

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: config, aiLog: () => {}, rng: null },
    );
    call = caller(server);
  });

  afterEach(async () => {
    await server.close();
    cleanup();
  });

  const mock = (fail: AiCallRequest['purpose'][] = [], rewrite?: (req: AiCallRequest, json: unknown) => unknown): AiProvider => {
    const inner = createMockProvider({ ...config, mockFail: Object.fromEntries(fail.map((p) => [p, 'timeout'])) }, undefined, cannedGmAnswer);
    return {
      ...inner,
      async call(req) {
        const res = await inner.call(req);
        return res.ok && rewrite ? { ...res, json: rewrite(req, res.json) } : res;
      },
    };
  };
  const run = (provider: AiProvider, maxUsd = 1) => runStyleEval({ db: server.orm, assets: server.assets, provider, config: { ...config, retryDelayMs: 0 }, now: () => CLOCK, log: () => {}, maxUsd });
  const count = (table: string) => (server.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
  const adminToken = async () => AdminSessionResponse.parse((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body).token;

  it('C2: one run gives a result for every scene + the Voice version + the models + USD, and touches no game', async () => {
    const result = await run(mock());
    expect(result.scenes.map((s) => s.sceneId)).toEqual(STYLE_SCENES.map((s) => s.id));
    expect(result.scenes.every((s) => s.ok && (s.text ?? '').length > 0)).toBe(true);
    expect(result.voiceVersion).toBe(server.assets.voice.version);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.costUsdMicros).toBeGreaterThan(0);
    expect(result.costUsdMicros).toBe(result.scenes.reduce((sum, s) => sum + s.costUsdMicros, 0));
    // The prompt of each scene is saved with the run (the admin page does not send it).
    const saved = server.db.prepare('select scenes from style_eval_run where id = ?').get(result.id) as { scenes: string };
    const scenes = JSON.parse(saved.scenes) as { prompt: { system: { id: string; text: string }[]; user: string } }[];
    expect(scenes.every((s) => s.prompt.system.length > 0 && s.prompt.user.length > 0)).toBe(true);
    expect(count('game')).toBe(0);
    expect(count('member')).toBe(0);
  });

  it('ISK-028 C5: the day-summary scene asks for the game\'s 3000 output tokens; the journal scene still 3000', async () => {
    const provider = mock();
    const calls: AiCallRequest[] = [];
    await run({ ...provider, call: (req) => (calls.push(req), provider.call(req)) });
    const day = calls.filter((r) => r.output.name === 'gm_day_summary');
    const journal = calls.filter((r) => r.output.name === 'gm_journal');
    expect(day.length).toBeGreaterThan(0);
    expect(journal.length).toBeGreaterThan(0);
    for (const r of day) expect([r.purpose, r.maxOutputTokens]).toEqual(['summarize_day', 3_000]);
    for (const r of journal) expect(r.maxOutputTokens).toBe(3_000);
  });

  it('ISK-028 thinking: the day-summary scene asks for thinking off like the game; no other scene does', async () => {
    const provider = mock();
    const calls: AiCallRequest[] = [];
    await run({ ...provider, call: (req) => (calls.push(req), provider.call(req)) });
    const day = calls.filter((r) => r.purpose === 'summarize_day');
    expect(day.length).toBeGreaterThan(0);
    for (const r of day) expect(r.thinking).toBe('off');
    for (const r of calls.filter((c) => c.purpose !== 'summarize_day')) expect(r).not.toHaveProperty('thinking');
  });

  it('C4: scenes the AI fails are reported failed; the rest of the set still runs', async () => {
    const result = await run(mock(['npc_dialogue']));
    const failed = result.scenes.filter((s) => !s.ok);
    expect(failed.map((s) => s.sceneId)).toEqual(STYLE_SCENES.filter((s) => s.purpose === 'npc_dialogue').map((s) => s.id));
    expect(failed.every((s) => s.text === null && (s.failure ?? '').startsWith('timeout'))).toBe(true);
    expect(result.scenes.filter((s) => s.ok)).toHaveLength(STYLE_SCENES.length - failed.length);
  });

  it('C4: past the spend limit the remaining scenes are reported as not run (no more calls)', async () => {
    const result = await run(mock(), 0.000001);
    expect(result.scenes[0]!.ok).toBe(true);
    expect(result.scenes.slice(1).every((s) => !s.ok && s.failure === 'budget')).toBe(true);
  });

  it('C5: a result with a real NPC name is flagged real_name', async () => {
    const leaky = mock([], (req, json) => (req.output.name === 'gm_scene' ? { text: 'โนอานั่งอยู่ริมน้ำพุ' } : json));
    const result = await run(leaky);
    const place = result.scenes.filter((s) => STYLE_SCENES.find((x) => x.id === s.sceneId)!.context.kind === 'gm_scene');
    expect(place.length).toBeGreaterThan(0);
    expect(place.every((s) => s.flags.includes('real_name'))).toBe(true);
    expect(result.scenes.filter((s) => s.flags.includes('real_name')).length).toBe(place.length);
  });

  it('C3: two rounds side by side scene by scene; Nok marks better / same / worse; the summary is saved', async () => {
    const token = await adminToken();
    expect((await call('GET', '/api/admin/style-eval')).status).toBe(403);
    const empty = StyleEvalResponse.parse((await call('GET', '/api/admin/style-eval', { token })).body);
    expect(empty).toMatchObject({ current: null, previous: null });

    const first = await run(mock());
    // One round only: nothing to compare with, so marking is refused.
    const lonely = await call('PUT', `/api/admin/style-eval/${first.id}/marks/${STYLE_SCENES[0]!.id}`, { token, body: { mark: 'better' } });
    expect(lonely.status).toBe(409);
    const second = await run(mock());

    const view = StyleEvalResponse.parse((await call('GET', '/api/admin/style-eval', { token })).body);
    expect(view.current?.id).toBe(second.id);
    expect(view.previous?.id).toBe(first.id);
    expect(view.current!.scenes.map((s) => s.sceneId)).toEqual(view.previous!.scenes.map((s) => s.sceneId));
    expect(view.summary).toEqual({ better: 0, same: 0, worse: 0, unmarked: STYLE_SCENES.length });
    expect(JSON.stringify(view)).not.toContain('"prompt"');

    const mark = (sceneId: string, m: 'better' | 'same' | 'worse' | null, t = token) =>
      call('PUT', `/api/admin/style-eval/${second.id}/marks/${sceneId}`, { ...(t ? { token: t } : {}), body: { mark: m } });
    const [a, b, c] = STYLE_SCENES;
    expect((await mark(a!.id, 'better')).status).toBe(200);
    expect((await mark(b!.id, 'worse')).status).toBe(200);
    expect((await mark(c!.id, 'same')).status).toBe(200);
    const changed = StyleEvalResponse.parse((await mark(b!.id, 'better')).body);
    expect(changed.marks).toEqual({ [a!.id]: 'better', [b!.id]: 'better', [c!.id]: 'same' });
    expect(changed.summary).toEqual({ better: 2, same: 1, worse: 0, unmarked: STYLE_SCENES.length - 3 });
    expect(StyleEvalResponse.parse((await mark(c!.id, null)).body).summary).toMatchObject({ same: 0, unmarked: STYLE_SCENES.length - 2 });

    // Saved: a fresh read has the marks.
    expect(StyleEvalResponse.parse((await call('GET', '/api/admin/style-eval', { token })).body).marks).toEqual({ [a!.id]: 'better', [b!.id]: 'better' });

    expect((await mark(a!.id, 'better', '')).status).toBe(403);
    const unknown = await mark('no-such-scene', 'better');
    expect(unknown.status).toBe(404);
    expect(ApiError.parse(unknown.body).code).toBe('response_not_found');
    expect((await call('PUT', `/api/admin/style-eval/999/marks/${a!.id}`, { token, body: { mark: 'better' } })).status).toBe(404);
    expect((await mark(a!.id, 'great' as 'better')).status).toBe(400);
  });

  // ISK-025: NPC replies are judged on length and the 4 parts (no real AI here: the Mock plays the judge).
  const npcScenes = STYLE_SCENES.filter((s) => s.purpose === 'npc_chat' || s.purpose === 'npc_dialogue');
  const isJudge = (req: AiCallRequest) => req.output.name === 'npc_reply_judge';
  const judging =
    (verdict: Record<'persona' | 'feeling' | 'reaction' | 'place', boolean>, reply?: string) =>
    (req: AiCallRequest, json: unknown): unknown => {
      if (isJudge(req)) return { verdicts: (JSON.parse(req.messages[0]!.text) as { replies: unknown[] }).replies.map(() => verdict) };
      if (reply !== undefined && req.output.name === 'npc_chat') return { ...(json as object), reply };
      return json;
    };
  const ALL = { persona: true, feeling: true, reaction: true, place: true };
  const flagged = (result: Awaited<ReturnType<typeof run>>, flag: string) => result.scenes.filter((s) => s.flags.includes(flag)).map((s) => s.sceneId);

  it('ISK-025 C8 (mock): every NPC scene is judged once on the summary model; short complete replies pass the bar', async () => {
    const provider = mock([], judging(ALL));
    const calls: AiCallRequest[] = [];
    const result = await run({ ...provider, call: (req) => (calls.push(req), provider.call(req)) });
    const judged = calls.filter(isJudge);
    expect(judged).toHaveLength(npcScenes.length);
    expect(judged.every((r) => r.purpose === 'npc_chat' && r.model === config.summaryModel)).toBe(true);
    expect(result.scenes.every((s) => s.ok)).toBe(true);
    const report = npcReplyReport(server.orm, result.id);
    expect(report.replies).toBeGreaterThanOrEqual(npcScenes.length);
    expect(report).toMatchObject({ withinLength: report.replies, complete: report.replies, completeRate: 1, pass: true });
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.samples.length).toBeLessThanOrEqual(5);
    // The judge's verdicts stay on the server: the admin page gets the flags only.
    expect(JSON.stringify(styleEvalView(server.orm))).not.toContain('verdict');
  });

  it('ISK-025 C8 (mock): a reply over 120 code points is flagged too_long and the round misses the bar', async () => {
    const result = await run(mock([], judging(ALL, 'ก'.repeat(150))));
    const chats = STYLE_SCENES.filter((s) => s.purpose === 'npc_chat').map((s) => s.id);
    expect(flagged(result, 'too_long')).toEqual(chats);
    const report = npcReplyReport(server.orm, result.id);
    expect(report.withinLength).toBe(report.replies - chats.length);
    expect(report.pass).toBe(false);
  });

  it('ISK-025 C8 (mock): a part the judge misses is flagged; under 80% complete misses the bar', async () => {
    const result = await run(mock([], judging({ ...ALL, feeling: false })));
    expect(flagged(result, 'missing_feeling')).toEqual(npcScenes.map((s) => s.id));
    expect(flagged(result, 'missing_persona')).toEqual([]);
    expect(npcReplyReport(server.orm, result.id)).toMatchObject({ complete: 0, completeRate: 0, pass: false });
  });

  it('ISK-025 C8 (mock): a failed judge is flagged and its replies do not count as complete', async () => {
    const result = await run(mock([], (req, json) => (isJudge(req) ? { verdicts: 'nope' } : json)));
    expect(flagged(result, 'judge_failed')).toEqual(npcScenes.map((s) => s.id));
    expect(npcReplyReport(server.orm, result.id).complete).toBe(0);
  });

  // ISK-026: the action results of the narration scenes, judged as the player reads them (the Mock plays the judge).
  const narrationScenes = STYLE_SCENES.filter((s) => s.context.kind === 'gm_narration');
  const isResultJudge = (req: AiCallRequest) => req.output.name === 'narration_judge';
  const judgingResults =
    (verdict: Record<'persona' | 'feeling' | 'reaction' | 'place' | 'playerChoice', boolean>, segment?: string) =>
    (req: AiCallRequest, json: unknown): unknown => {
      if (isResultJudge(req)) return { verdicts: (JSON.parse(req.messages[0]!.text) as { results: unknown[] }).results.map(() => verdict) };
      if (segment !== undefined && req.output.name === 'gm_narration') {
        const out = json as { segments: { actionId: string; text: string }[] };
        return { ...out, segments: out.segments.map((s) => ({ ...s, text: segment })) };
      }
      return json;
    };
  const RESULT_ALL = { ...ALL, playerChoice: true };

  it('ISK-026 C7 (mock): every narration scene is judged once on the summary model; short results with all 4 parts pass the bar', async () => {
    const provider = mock([], judgingResults(RESULT_ALL));
    const calls: AiCallRequest[] = [];
    const result = await run({ ...provider, call: (req) => (calls.push(req), provider.call(req)) });
    const judged = calls.filter(isResultJudge);
    expect(judged).toHaveLength(narrationScenes.length);
    expect(judged.every((r) => r.purpose === 'npc_chat' && r.model === config.summaryModel)).toBe(true);
    const report = narrationReport(server.orm, result.id);
    expect(report.results).toBeGreaterThanOrEqual(narrationScenes.length);
    expect(report).toMatchObject({ withinLength: report.results, complete: report.results, completeRate: 1, respectsPlayer: report.results, pass: true, overRaw: 0 });
    expect(report.samples.length).toBeGreaterThan(0);
    expect(JSON.stringify(styleEvalView(server.orm))).not.toContain('verdict');
  });

  it('ISK-026 C7 (mock): a result of 180 code points is judged as the player reads it (cut within 120); its raw length is reported', async () => {
    const said = Array.from({ length: 9 }, () => 'ก'.repeat(19)).join(' ') + 'ข';
    const calls: AiCallRequest[] = [];
    const provider = mock([], judgingResults(RESULT_ALL, said));
    const result = await run({ ...provider, call: (req) => (calls.push(req), provider.call(req)) });
    const judged = calls.filter(isResultJudge).flatMap((r) => (JSON.parse(r.messages[0]!.text) as { results: string[] }).results);
    expect(judged.length).toBeGreaterThan(0);
    for (const text of judged) {
      expect([...text].length).toBeLessThanOrEqual(120);
      expect(said.startsWith(text)).toBe(true);
    }
    const report = narrationReport(server.orm, result.id);
    expect(report).toMatchObject({ withinLength: report.results, overRaw: report.results, pass: true });
    expect(flagged(result, 'too_long')).toEqual([]);
  });

  it('ISK-026 C12 (mock): the judge also says whether a result decides or feels for the player beyond the action; a no is flagged and reported', async () => {
    const result = await run(mock([], judgingResults({ ...RESULT_ALL, playerChoice: false })));
    expect(flagged(result, 'decides_for_player')).toEqual(narrationScenes.map((s) => s.id));
    const report = narrationReport(server.orm, result.id);
    expect(report.respectsPlayer).toBe(0);
    expect(report.complete).toBe(report.results);
    const calls: AiCallRequest[] = [];
    const provider = mock([], judgingResults(RESULT_ALL));
    await run({ ...provider, call: (req) => (calls.push(req), provider.call(req)) });
    expect(calls.find(isResultJudge)!.system.map((b) => b.text).join('\n')).toMatch(/playerChoice: .*(decide|feel).*player/);
  });

  it('ISK-026 C7 (mock): a narration judge that fails is flagged result_judge_failed; the NPC replies are not affected', async () => {
    const result = await run(mock([], (req, json) => (isResultJudge(req) ? { verdicts: 'nope' } : judging(ALL)(req, json))));
    expect(flagged(result, 'result_judge_failed')).toEqual(narrationScenes.map((s) => s.id));
    expect(narrationReport(server.orm, result.id)).toMatchObject({ complete: 0, pass: false });
    expect(npcReplyReport(server.orm, result.id).pass).toBe(true);
  });

  it('ISK-025 C4: a reply that brings up rain in a scene without rain is flagged not_in_scene; with rain it is fine', async () => {
    const result = await run(mock([], judging(ALL, 'ฝนตกหนักแบบนี้ ยังจะมาอีกหรือ')));
    const chats = STYLE_SCENES.filter((s) => s.context.kind === 'npc_chat');
    const rainy = (s: (typeof chats)[number]) => s.context.kind === 'npc_chat' && (s.context.chat.scene.weather === 'Rain' || s.context.chat.scene.weather === 'Storm');
    expect(chats.filter(rainy).length).toBeGreaterThan(0);
    expect(chats.filter((s) => !rainy(s)).length).toBeGreaterThan(0);
    expect(flagged(result, 'not_in_scene')).toEqual(chats.filter((s) => !rainy(s)).map((s) => s.id));
  });
});

describe('ISK-026 the narration scenes of the eval set', () => {
  it('ISK-026 C7: at least 6 narration scenes of action results, private and place feed, one of 3 actions and one with an arrival', () => {
    const scenes = STYLE_SCENES.flatMap((s) => (s.context.kind === 'gm_narration' ? [s.context] : []));
    expect(scenes.length).toBeGreaterThanOrEqual(6);
    expect(scenes.some((c) => 'player' in c.audience)).toBe(true);
    expect(scenes.some((c) => 'place' in c.audience)).toBe(true);
    expect(scenes.some((c) => c.beats.filter((b) => b.kind !== 'arrival').length >= 3)).toBe(true);
    expect(scenes.some((c) => c.arrival !== undefined && c.beats.at(-1)?.kind === 'arrival')).toBe(true);
  });
});

describe('ISK-025 the NPC scenes of the eval set', () => {
  it('at least 6 NPC chat scenes and 6 turn NPC line scenes, every chat a real chat prompt (tokens only)', () => {
    const chats = STYLE_SCENES.filter((s) => s.purpose === 'npc_chat');
    expect(chats.length).toBeGreaterThanOrEqual(6);
    expect(STYLE_SCENES.filter((s) => s.purpose === 'npc_dialogue' && s.context.kind === 'gm_dialogue').length).toBeGreaterThanOrEqual(6);
    for (const s of chats) {
      expect(s.context.kind).toBe('npc_chat');
      if (s.context.kind !== 'npc_chat') continue;
      expect(s.context.chat.npc.token).toBe(`{{n:${s.npcs[0]}}}`);
      expect(s.context.chat.message.length).toBeGreaterThan(0);
    }
  });
});
