import { AdminSessionResponse, ApiError, AppearanceOptionsResponse, CharacterResponse, CreateGameResponse, defaultScenario, JoinResponse, SurroundingsResponse, type AppearanceOption } from '@isekai/protocol';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { hashPin } from '../src/auth/pin.ts';
import { cannedGmAnswer, contextOf } from '../src/gm/mock-gm.ts';
import type { NarrationContext } from '../src/gm/context.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { presenceOf } from '../src/visibility/store.ts';
import { makeTempDir, withLooks } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call } from './visibility-fixture.ts';

// ISK-006: a new character picks a preset avatar and appearance chips (+ a short free text); the server builds the
// appearance sentence once at creation and stores it. The chip list is the game data set Appearance_Options.

const ADMIN_CODE = 'ทดสอบ-ชิป-006';
const SET = 'Appearance_Options';

const C1_TRAITS = { hairColor: 'black', hairStyle: 'long', eyes: 'blue', build: 'tall', outfit: 'traveler', feature: 'scar' };
const C1_SENTENCE = 'ผมยาวสีดำ ดวงตาสีฟ้า รูปร่างผอมสูง สวมชุดเดินทาง มีแผลเป็นที่แก้ม';
const body = (patch: Record<string, unknown> = {}) => ({ name: 'ลิน', personality: 'ช่างสังเกต พูดน้อย', avatarId: 'avatar-03', appearanceTraits: C1_TRAITS, ...patch });

describe('character avatar + appearance chips (ISK-006)', { timeout: 120_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
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

  async function boot(aiProvider?: AiProvider) {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: join(dataDir, 'isekai.sqlite'), createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }), aiLog: () => {}, rng: null, ...(aiProvider ? { aiProvider } : {}) },
    );
    call = caller(server);
  }

  async function lobby() {
    const created = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, name: 'นก', pin: '1234' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const game = CreateGameResponse.parse(created.body);
    const join = async (name: string) => {
      const res = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name, pin: '1111' } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const joined = JoinResponse.parse(res.body);
      return { token: joined.token, memberId: joined.member.id };
    };
    return { owner: { token: game.token, memberId: game.member.id }, join };
  }

  const post = (token: string, b: unknown) => call('POST', '/api/game/character', { token, body: b });
  const created = async (token: string, b: unknown) => {
    const res = await post(token, b);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return CharacterResponse.parse(res.body).character!;
  };
  const refused = async (token: string, b: unknown) => {
    const res = await post(token, b);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    return ApiError.parse(res.body);
  };
  const stored = (memberId: string) => server!.db.prepare('select appearance, avatar_id, appearance_traits from character where member_id = ?').get(memberId) as { appearance: string; avatar_id: string | null; appearance_traits: string | null };

  async function adminToken() {
    const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AdminSessionResponse.parse(res.body).token;
  }
  async function editOptions(edit: (options: AppearanceOption[]) => AppearanceOption[]) {
    const token = await adminToken();
    const current = (await call('GET', `/api/admin/game-data/${SET}`, { token })).body as { value: AppearanceOption[] };
    return call('PUT', `/api/admin/game-data/${SET}`, { token, body: { value: edit(current.value) } });
  }
  const options = async () => {
    const res = await call('GET', '/api/appearance-options');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AppearanceOptionsResponse.parse(res.body);
  };

  it('C1: the chips are saved as the sentence, with the avatar and the chips', async () => {
    await boot();
    const { owner } = await lobby();
    const character = await created(owner.token, body());
    expect(character).toMatchObject({ appearance: C1_SENTENCE, avatarId: 'avatar-03', appearanceTraits: C1_TRAITS });
    expect(stored(owner.memberId)).toMatchObject({ appearance: C1_SENTENCE, avatar_id: 'avatar-03' });
    expect(JSON.parse(stored(owner.memberId).appearance_traits!)).toEqual(C1_TRAITS);
  });

  it('C2: shaved + heterochromia + no feature + extra: no double space, the extra kept as typed (line break = one space)', async () => {
    await boot();
    const { owner } = await lobby();
    const traits = { hairColor: 'white', hairStyle: 'shaved', eyes: 'heterochromia', build: 'muscular', outfit: 'leather', feature: 'none', extra: ' ถือไม้เท้าเก่า\n<b>ผ้าพันคอ</b> ' };
    const character = await created(owner.token, body({ appearanceTraits: traits }));
    expect(character.appearance).toBe('ศีรษะโกนเกลี้ยง ดวงตาสองสี รูปร่างล่ำสัน สวมเกราะหนัง ถือไม้เท้าเก่า <b>ผ้าพันคอ</b>');
    expect(character.appearance).not.toMatch(/\s{2}/);
  });

  it('C3: an unknown value or a missing category is 400 invalid_trait naming the field', async () => {
    await boot();
    const { owner } = await lobby();
    expect(await refused(owner.token, body({ appearanceTraits: { ...C1_TRAITS, hairColor: 'purple' } }))).toMatchObject({ code: 'invalid_trait', field: 'hairColor' });
    const { build: _, ...noBuild } = C1_TRAITS;
    expect(await refused(owner.token, body({ appearanceTraits: noBuild }))).toMatchObject({ code: 'invalid_trait', field: 'build' });
    expect(await refused(owner.token, body({ appearanceTraits: undefined }))).toMatchObject({ code: 'invalid_trait' });
    expect(stored(owner.memberId)).toBeUndefined();
  });

  it('C4: extra up to 80 code points; 81 is extra_too_long; a real NPC name or a {{ }} token is extra_forbidden', async () => {
    await boot();
    const { owner, join } = await lobby();
    const kham = 'กำ'; // 2 code points
    const at80 = kham.repeat(40);
    expect([...at80]).toHaveLength(80);
    expect((await created(owner.token, body({ appearanceTraits: { ...C1_TRAITS, extra: at80 } }))).appearance).toBe(`${C1_SENTENCE} ${at80}`);

    const b = await join('บี');
    expect(await refused(b.token, body({ appearanceTraits: { ...C1_TRAITS, extra: `${at80}ข` } }))).toMatchObject({ code: 'extra_too_long' });
    const merchant = defaultScenario().npcs.find((n) => n.id === 'merchant')!;
    expect(await refused(b.token, body({ appearanceTraits: { ...C1_TRAITS, extra: `เพื่อนของ${merchant.name}` } }))).toMatchObject({ code: 'extra_forbidden' });
    expect(await refused(b.token, body({ appearanceTraits: { ...C1_TRAITS, extra: 'ถือป้าย {{p:x}}' } }))).toMatchObject({ code: 'extra_forbidden' });
    expect(stored(b.memberId)).toBeUndefined();
  });

  it('C5: no avatarId or one outside the presets is 400 invalid_avatar', async () => {
    await boot();
    const { owner } = await lobby();
    expect(await refused(owner.token, body({ avatarId: undefined }))).toMatchObject({ code: 'invalid_avatar' });
    expect(await refused(owner.token, body({ avatarId: 'avatar-13' }))).toMatchObject({ code: 'invalid_avatar' });
    expect(stored(owner.memberId)).toBeUndefined();
  });

  it('C6: an old character (no avatar, no chips) keeps its appearance, is seen by it and plays on', async () => {
    await boot();
    const t = await startedTable(server!, false);
    // As a character made before ISK-006 is after the migration: the free text, null avatar and chips.
    server!.db.prepare('update character set appearance = ?, avatar_id = null, appearance_traits = null where member_id = ?').run('ชายร่างสูงสวมเกราะหนังเก่า', t.b.memberId);

    const own = CharacterResponse.parse((await call('GET', '/api/game/character', { token: t.b.token })).body).character!;
    expect(own).toMatchObject({ appearance: 'ชายร่างสูงสวมเกราะหนังเก่า', avatarId: null, appearanceTraits: null });
    const seen = SurroundingsResponse.parse((await call('GET', '/api/game/surroundings', { token: t.a.token })).body);
    expect(seen.view === 'player' && seen.people.find((p) => p.appearance === 'ชายร่างสูงสวมเกราะหนังเก่า')).toMatchObject({ avatarId: null, name: null });

    const b = await openRoom(server!, { token: t.b.token });
    sockets.push(b);
    await b.waitFor(isReady);
    b.action('เดินดูตลาด', 'public');
    await b.waitFor((m) => m.type === 'action_accepted');
    expect(stored(t.b.memberId).appearance).toBe('ชายร่างสูงสวมเกราะหนังเก่า');
  });

  it('C7: B, who does not know A, sees A\'s avatar and the built appearance, not the name', async () => {
    await boot();
    const t = await startedTable(server!, false);
    const seen = SurroundingsResponse.parse((await call('GET', '/api/game/surroundings', { token: t.b.token })).body);
    expect(seen.view).toBe('player');
    const a = seen.view === 'player' ? seen.people.find((p) => p.appearance === t.a.appearance) : undefined;
    expect(a).toEqual({ ref: expect.any(String), avatarId: 'avatar-01', appearance: t.a.appearance, injury: 'ปกติ', socialTitle: expect.any(String), name: null });
    expect(t.a.appearance).toMatch(/^ผมสั้นสีดำ ดวงตาสีดำ รูปร่างสมส่วน สวมชุดชาวบ้าน /);
    expect(JSON.stringify(seen)).not.toContain(t.a.name);
  });

  it('C8: the admin renames outfit traveler: new characters get the new words, old ones keep their sentence', async () => {
    await boot();
    const { owner, join } = await lobby();
    expect((await created(owner.token, body())).appearance).toBe(C1_SENTENCE);

    const res = await editOptions((list) => list.map((o) => (o.category === 'outfit' && o.id === 'traveler' ? { ...o, label: 'ชุดนักเดินทาง' } : o)));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await options()).categories.outfit).toContainEqual({ id: 'traveler', label: 'ชุดนักเดินทาง' });

    const b = await join('บี');
    expect((await created(b.token, body({ name: 'บี' }))).appearance).toBe('ผมยาวสีดำ ดวงตาสีฟ้า รูปร่างผอมสูง สวมชุดนักเดินทาง มีแผลเป็นที่แก้ม');
    expect(CharacterResponse.parse((await call('GET', '/api/game/character', { token: owner.token })).body).character!.appearance).toBe(C1_SENTENCE);
  });

  it('C8: ids stay fixed: a save that drops a value is refused (hide it instead)', async () => {
    await boot();
    const res = await editOptions((list) => list.filter((o) => !(o.category === 'outfit' && o.id === 'noble')));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect((await options()).categories.outfit.map((o) => o.id)).toContain('noble');
  });

  it('C9: the turn narration prompt carries the player\'s built appearance', async () => {
    const requests: AiCallRequest[] = [];
    await boot({
      id: 'mock',
      ready: () => ({ ok: true }),
      estimateTokens: (text) => Math.ceil(text.length / 3),
      async call(req) {
        requests.push(req);
        return mockReply.ok(await cannedGmAnswer(req));
      },
    });
    const t = await startedTable(server!, false);
    const clients: RoomClient[] = [];
    for (const seat of [t.a, t.b, t.c]) {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      clients.push(c);
      await c.waitFor(isReady);
    }
    for (const [i, c] of clients.entries()) c.action(['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ'][i]!, 'public');
    await clients[0]!.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration');

    const refA = presenceOf(server!.orm, t.a.memberId)!.ref;
    const mine = requests
      .filter((r) => r.output.name === 'gm_narration')
      .map((r) => contextOf<NarrationContext>(r))
      .filter((ctx) => 'player' in ctx.audience && (ctx.audience as { player: string }).player === refA);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]!.cast.find((c) => c.self)?.looks).toBe(t.a.appearance);
    expect(t.a.appearance).toBe(withLooks({ appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง' }).appearance);
  });

  it('C10: GET /api/appearance-options needs no login and lists 6 categories with id + label; the old create contract still works', async () => {
    await boot();
    const list = await options();
    expect(Object.keys(list.categories)).toEqual(['hairColor', 'hairStyle', 'eyes', 'build', 'outfit', 'feature']);
    expect(list.categories.hairColor).toEqual([
      { id: 'black', label: 'ดำ' },
      { id: 'brown', label: 'น้ำตาล' },
      { id: 'blond', label: 'ทอง' },
      { id: 'silver', label: 'เงิน' },
      { id: 'red', label: 'แดง' },
      { id: 'white', label: 'ขาว' },
    ]);
    expect(list.categories.build.map((o) => o.id)).toEqual(['tall', 'average', 'muscular', 'small', 'stout']);

    // Name and personality are checked as before (GEN-047).
    const { owner } = await lobby();
    expect(await refused(owner.token, body({ name: '' }))).toMatchObject({ code: 'invalid_input', fields: { name: 'กรุณาใส่ชื่อจริงของตัวละคร' } });
  });

  it('C11: a hidden value is not offered, cannot be picked, and an old character with it keeps its sentence', async () => {
    await boot();
    const { owner, join } = await lobby();
    const mage = await created(owner.token, body({ appearanceTraits: { ...C1_TRAITS, outfit: 'mage' } }));
    expect(mage.appearance).toContain('สวมเสื้อคลุมนักเวท');

    const res = await editOptions((list) => list.map((o) => (o.category === 'outfit' && o.id === 'mage' ? { ...o, hidden: true } : o)));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await options()).categories.outfit.map((o) => o.id)).not.toContain('mage');

    const b = await join('บี');
    expect(await refused(b.token, body({ name: 'บี', appearanceTraits: { ...C1_TRAITS, outfit: 'mage' } }))).toMatchObject({ code: 'invalid_trait', field: 'outfit' });
    expect(CharacterResponse.parse((await call('GET', '/api/game/character', { token: owner.token })).body).character!.appearance).toBe(mage.appearance);
  });
});
