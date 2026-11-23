import { AdminSessionResponse, CreateGameResponse, GameView, StyleSettingsResponse, type RoomServerMessage } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { VoiceAsset } from '../src/assets/voice.ts';
import { hashPin } from '../src/auth/pin.ts';
import { cannedGmAnswer } from '../src/gm/mock-gm.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call, type Table } from './visibility-fixture.ts';

// GEN-177: the language tone (A default / B / C) of a game: picked at creation, in the stable start of the
// narration and dialogue prompts, locked once the game starts; the server default is set at /admin.

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-โทน-177';

const isNarration = (r: AiCallRequest) => r.output.name === 'gm_narration';
const isDialogue = (r: AiCallRequest) => r.output.name === 'gm_dialogue';
const toneOf = (r: AiCallRequest) => r.system.find((b) => b.id === 'tone');

describe('language tone (GEN-177)', { timeout: 90_000 }, () => {
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

  const create = async (extra: Record<string, unknown> = {}) => {
    const res = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'เกมโทน', mode: 'online', humanGm: false, name: 'นก', pin: '1234', ...extra } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CreateGameResponse.parse(res.body);
  };
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
    // The next turn (turn 2), or after turn 2 the next period's turn 1.
    const next = (m: RoomServerMessage) => m.type === 'room' && m.status === 'collecting' && (turn === 1 ? m.turn === 2 : m.turn === 1);
    for (const [i, c] of clients.entries()) await c.waitFor(next, starts[i]);
    for (const end = Date.now() + 3_000; requests.filter(isDialogue).length === dialogues && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    await Promise.all(sockets.splice(0).map((s) => s.close()));
  }

  it('C1: a game created without choosing has tone A, and A is in the narration prompt', async () => {
    expect((await create()).game.tone).toBe('A');
    const t = await startedTable(server, false);
    await playAtFountain(t);
    const narration = requests.filter(isNarration);
    expect(narration.length).toBeGreaterThan(0);
    for (const r of narration) expect(toneOf(r)?.text).toContain(server.assets.voice.tones.A.samples[0]);
  });

  it('C2: tone B is in both the narration and the dialogue prompts, and A is not', async () => {
    const t = await startedTable(server, false, { tone: 'B' });
    await playAtFountain(t);
    const narration = requests.filter(isNarration);
    const dialogue = requests.filter(isDialogue);
    expect(narration.length).toBeGreaterThan(0);
    expect(dialogue.length).toBeGreaterThan(0);
    for (const r of [...narration, ...dialogue]) {
      const block = toneOf(r)!;
      expect(block.text).toContain(server.assets.voice.tones.B.samples[0]);
      expect(block.text).not.toContain(server.assets.voice.tones.A.samples[0]);
      // In the stable start: a cached system block, never in the per-turn messages.
      expect(block.cache).toBe(true);
      expect(JSON.stringify(r.messages)).not.toContain(server.assets.voice.tones.B.samples[0]);
    }
  });

  it('C3 (ISK-017): the tone is set at creation and locked: no edit route (404), a bad tone 400', async () => {
    const created = await create({ tone: 'C' });
    expect(created.game.tone).toBe('C');
    expect((await call('PATCH', '/api/game', { token: created.token, body: { tone: 'B' } })).status).toBe(404);
    expect(GameView.parse((await call('GET', '/api/game', { token: created.token })).body).tone).toBe('C');
    expect((await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'เกม', mode: 'single', humanGm: false, name: 'นก', pin: '1234', tone: 'D' } })).status).toBe(400);
  });

  it('C4: the admin sets the default to C: new games get C, games made before keep theirs', async () => {
    const before = await create();
    const token = AdminSessionResponse.parse((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body).token;
    expect(StyleSettingsResponse.parse((await call('GET', '/api/admin/style-settings', { token })).body).settings.defaultTone).toBe('A');
    const put = await call('PUT', '/api/admin/style-settings', { token, body: { defaultTone: 'C' } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(StyleSettingsResponse.parse(put.body).settings).toEqual({ rewrite: false, defaultTone: 'C' });
    expect((await create()).game.tone).toBe('C');
    expect((await create({ tone: 'B' })).game.tone).toBe('B');
    expect(GameView.parse((await call('GET', '/api/game', { token: before.token })).body).tone).toBe('A');
    expect((await call('PUT', '/api/admin/style-settings', { token, body: { defaultTone: 'Z' } })).status).toBe(400);
  });

  it('C5: two calls in a row start byte-identical (system blocks), whatever the turn', async () => {
    const t = await startedTable(server, false, { tone: 'B' });
    await playAtFountain(t, 1);
    await playAtFountain(t, 2);
    const narration = requests.filter((r) => isNarration(r) && 'place' in (JSON.parse(r.messages[0]!.text) as { audience: object }).audience);
    expect(narration.length).toBeGreaterThanOrEqual(2);
    const first = JSON.stringify(narration[0]!.system);
    for (const r of narration.slice(1)) expect(JSON.stringify(r.system)).toBe(first);
    const dialogue = requests.filter(isDialogue);
    expect(dialogue.length).toBeGreaterThanOrEqual(2);
    for (const r of dialogue.slice(1)) expect(JSON.stringify(r.system)).toBe(JSON.stringify(dialogue[0]!.system));
  });

  it('GEN-194 C1+C2: the period-change scene prompt has tone B in its cached start, byte-identical call to call', async () => {
    const t = await startedTable(server, false, { tone: 'B' });
    await playAtFountain(t, 1);
    await playAtFountain(t, 2);
    const scenes = requests.filter((r) => r.output.name === 'gm_scene');
    // A and B at the fountain, C elsewhere: one scene per place, so two calls to compare.
    expect(scenes.length).toBeGreaterThanOrEqual(2);
    for (const r of scenes) {
      expect(r.system.map((b) => b.id)).toEqual(['scene-rules', 'tone']);
      const block = toneOf(r)!;
      expect(block.cache).toBe(true);
      expect(block.text).toContain(server.assets.voice.tones.B.samples[0]);
      expect(block.text).not.toContain(server.assets.voice.tones.A.samples[0]);
      expect(JSON.stringify(r.system)).toBe(JSON.stringify(scenes[0]!.system));
    }
  });

  it('the NPC speech profiles are the same for every tone (one profile set, no per-tone copy)', () => {
    const voice = server.assets.voice;
    expect(Object.keys(voice.tones).sort()).toEqual(['A', 'B', 'C']);
    for (const tone of Object.values(voice.tones)) {
      expect(tone.description.length).toBeGreaterThan(0);
      expect(tone.samples.length).toBeGreaterThan(0);
      expect(JSON.stringify(tone)).not.toContain('"npcs"');
    }
    // A Voice row saved before GEN-177 (no `tones`) still loads, with the same tones as voice.json.
    const { tones, ...older } = voice;
    expect(VoiceAsset.parse(older).tones).toEqual(tones);
  });
});
