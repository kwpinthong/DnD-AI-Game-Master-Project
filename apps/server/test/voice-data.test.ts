import { AdminSessionResponse, ApiError, defaultScenario, GameDataSetResponse } from '@isekai/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ASSETS_DIR } from '../src/assets/load.ts';
import { VoiceAsset } from '../src/assets/voice.ts';
import { hashPin } from '../src/auth/pin.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, type Call } from './visibility-fixture.ts';

// GEN-176: the Thai style guide + NPC speech profiles (GEN-166) are the Voice data set in the DB, edited from /admin.

/** A throwaway admin code for this test only. */
const ADMIN_CODE = 'ทดสอบ-สำนวน-176';

const voiceFile = () => JSON.parse(readFileSync(join(DEFAULT_ASSETS_DIR, 'voice.json'), 'utf8').replace(/\r\n/g, '\n')) as Record<string, unknown>;
type Raw = { npcs: Record<string, { self: string[]; you: { default: string }; forms?: Record<string, unknown> }>; forbidden: { id: string; match: { type: string; value?: string } }[] };

/** GEN-166 section 2: id → [self, listener]; amnesiac drops the subject. */
const PAIRS: Record<string, [string | undefined, string]> = {
  beggar: ['ผม', 'พี่'],
  amnesiac: [undefined, 'เธอ'],
  nun: ['ดิฉัน', 'ท่าน'],
  guard: ['ข้า', 'เจ้า'],
  'cloaked-man': ['ฉัน', 'สหาย'],
  merchant: ['ข้าน้อย', 'ท่าน'],
  noble: ['กระผม', 'ท่าน'],
  archbishop: ['พ่อ', 'ลูก'],
  archivist: ['ฉัน', 'คุณ'],
  'light-spirit': ['เรา', 'เจ้า'],
  'dark-spirit': ['ข้า', 'มนุษย์'],
  'horizon-watcher': ['ผู้บันทึก', 'ผู้มาเยือน'],
};

describe('Voice data set (GEN-176)', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
  let token = '';

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null },
    );
    call = caller(server);
    token = AdminSessionResponse.parse((await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body).token;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const getVoice = async () => GameDataSetResponse.parse((await call('GET', '/api/admin/game-data/Voice', { token })).body);

  it('C1: an empty DB gets a Voice set equal to voice.json, which passes the zod schema', async () => {
    const file = voiceFile();
    expect(VoiceAsset.safeParse(file).success).toBe(true);
    const set = await getVoice();
    expect(set.value).toEqual(file);
    expect(set.set.file).toBe('voice.json');
    expect(server!.assets.voice).toEqual(VoiceAsset.parse(file));
  });

  it('C2: all 12 NPCs have a profile with the pronoun pairs of the note, and no two share a pair', () => {
    const { npcs } = voiceFile() as unknown as Raw;
    const ids = defaultScenario().npcs.map((n) => n.id);
    expect(ids).toHaveLength(12);
    expect(Object.keys(npcs).sort()).toEqual([...ids].sort());
    for (const [id, [self, you]] of Object.entries(PAIRS)) {
      expect(npcs[id]!.self[0], id).toBe(self);
      expect(npcs[id]!.you.default, id).toBe(you);
    }
    const pairs = Object.values(npcs).map((p) => `${p.self[0] ?? '-'}/${p.you.default}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('C3: the SS drafts have their own forms inside the main profile', () => {
    const { npcs } = voiceFile() as unknown as Raw;
    expect(Object.keys(npcs.beggar!.forms ?? {}).sort()).toEqual(['ss_evil', 'ss_good']);
    expect(Object.keys(npcs.amnesiac!.forms ?? {})).toEqual(['ss']);
    expect(VoiceAsset.parse(voiceFile()).npcs.beggar!.forms!.ss_good!.self).toEqual(['เรา']);
  });

  it('C4: an /admin edit that breaks the schema is refused with the field; the old value stays', async () => {
    const before = (await getVoice()).value as Raw;
    const badRegister = structuredClone(before) as unknown as { npcs: Record<string, Record<string, unknown>> };
    badRegister.npcs.guard!.register = 'loud';
    const res = await call('PUT', '/api/admin/game-data/Voice', { token, body: { value: badRegister } });
    expect(res.status).toBe(400);
    const error = ApiError.parse(res.body);
    expect(error.code === 'invalid_input' ? Object.keys(error.fields) : []).toContain('npcs.guard.register');

    // A real NPC name in a profile (it goes into prompts that use tokens) and an NPC id the scenario lacks.
    const leak = structuredClone(before) as unknown as { npcs: Record<string, Record<string, unknown>> };
    leak.npcs.guard!.note = 'ห้วน เหมือนการ์เร็ตตัวจริง';
    const leakRes = await call('PUT', '/api/admin/game-data/Voice', { token, body: { value: leak } });
    expect(leakRes.status).toBe(400);
    const leakError = ApiError.parse(leakRes.body);
    expect(leakError.code === 'invalid_input' ? Object.keys(leakError.fields) : []).toContain('npcs.guard.note');
    expect(JSON.stringify(leakRes.body)).not.toContain('การ์เร็ต');

    const unknown = structuredClone(before) as unknown as { npcs: Record<string, unknown> };
    unknown.npcs['no-such-npc'] = unknown.npcs.guard;
    expect((await call('PUT', '/api/admin/game-data/Voice', { token, body: { value: unknown } })).status).toBe(400);

    expect((await getVoice()).value).toEqual(before);

    const ok = structuredClone(before) as unknown as { npcs: Record<string, Record<string, unknown>> };
    ok.npcs.guard!.note = 'ห้วน สั่งการ (แก้จาก admin)';
    expect((await call('PUT', '/api/admin/game-data/Voice', { token, body: { value: ok } })).status).toBe(200);
    expect(server!.assets.voice.npcs.guard!.note).toBe('ห้วน สั่งการ (แก้จาก admin)');
  });

  it('C5: every regex of a ForbiddenRule compiles; one that does not is refused with its field', () => {
    const { forbidden } = voiceFile() as unknown as Raw;
    const regexes = forbidden.filter((r) => r.match.type === 'regex');
    expect(regexes.length).toBeGreaterThanOrEqual(8);
    for (const r of regexes) expect(() => new RegExp(r.match.value!, 'mu'), r.id).not.toThrow();

    const broken = structuredClone(voiceFile()) as unknown as Raw;
    broken.forbidden[0]!.match.value = '(ทำการ';
    const parsed = VoiceAsset.safeParse(broken);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('forbidden.0.match.value');
  });
});
