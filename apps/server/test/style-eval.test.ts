import { AdminSessionResponse, ApiError, StyleEvalResponse } from '@isekai/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { createMockProvider } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import { runStyleEval } from '../src/eval/style-eval.ts';
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
    expect(STYLE_SCENES.length).toBeLessThanOrEqual(20);
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
});
