// GEN-130: CharacterView carries the kept strength / weakness (tokens resolved), for the owner only.
import { CharacterResponse, CharacterView, CreateGameResponse, JoinResponse, OtherCharacterView } from '@isekai/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir, seedChosenLoot, withLooks } from './helpers.ts';

const CREATE_CODE = 'ลับเฉพาะ-2026';
const lin = withLooks({ name: 'ลิน', appearance: 'หญิงผ้าคลุมเทา', personality: 'ช่างสังเกต พูดน้อย' });

describe('GEN-130 strength / weakness in the character view', { timeout: 60_000 }, () => {
  let createCodeHash = '';
  let cleanup = () => {};
  let dataDir = '';
  let server: RunningServer | undefined;

  beforeAll(async () => {
    createCodeHash = await hashPin(CREATE_CODE);
  });
  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const res = await fetch(`${server!.url}${path}`, { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as unknown };
  }

  async function setup() {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash },
      { now: () => Date.UTC(2026, 10, 22, 12), ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {} },
    );
    const a = CreateGameResponse.parse((await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'เมือง', mode: 'online', humanGm: false, name: 'นก', pin: '1234' } })).body);
    const b = JoinResponse.parse((await call('POST', '/api/join', { body: { inviteCode: a.game.inviteCode, name: 'เบล', pin: '1111' } })).body);
    for (const who of [a, b]) expect((await call('POST', '/api/game/character', { token: who.token, body: lin })).status).toBe(201);
    return { a, b };
  }

  const mine = async (token: string) => CharacterResponse.parse((await call('GET', '/api/game/character', { token })).body).character;

  it('C3: the fields are in the schema (owner view only; other players have no such field)', () => {
    expect(Object.keys(CharacterView.shape)).toEqual(expect.arrayContaining(['strength', 'weakness']));
    expect(Object.keys(OtherCharacterView.shape)).not.toContain('strength');
  });

  it('C1: the owner sees the kept strength / weakness with their own token resolved and no {{ left', async () => {
    const { a } = await setup();
    expect((await mine(a.token))).toMatchObject({ strength: null, weakness: null });

    seedChosenLoot(server!.db, a.member.id);
    const row = server!.db.prepare('select chosen_json from character_loot where member_id = ?').get(a.member.id) as { chosen_json: string };
    const chosen = JSON.parse(row.chosen_json) as { strength: { label: string; description: string }; weakness: { description: string } };
    chosen.strength.description = `{{p:${a.member.id}}} มองเห็นสิ่งที่ {{p:someone-else}} พลาด`;
    server!.db.prepare('update character_loot set chosen_json = ? where member_id = ?').run(JSON.stringify(chosen), a.member.id);

    const view = await mine(a.token);
    expect(view?.strength).toEqual({ label: 'ช่างสังเกต', description: 'ลิน มองเห็นสิ่งที่ ใครบางคน พลาด' });
    expect(view?.weakness).toEqual({ label: 'ลังเล', description: 'คิดนาน' });
    expect(JSON.stringify(view)).not.toContain('{{');
  });

  it("C2: another player's own view carries only their own traits, and the other-player view has none", async () => {
    const { a, b } = await setup();
    seedChosenLoot(server!.db, a.member.id);
    expect((await mine(a.token))?.strength).not.toBeNull();
    expect(await mine(b.token)).toMatchObject({ strength: null, weakness: null });
    // what B gets about A in the surroundings (same place or not) never has a trait
    const around = await call('GET', '/api/game/surroundings', { token: b.token });
    expect(JSON.stringify(around.body)).not.toContain('ลังเล');
  });
});
