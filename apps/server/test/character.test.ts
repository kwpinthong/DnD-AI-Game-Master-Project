import { ApiError, CharacterResponse, CreateGameResponse, GameView, JoinResponse } from '@isekai/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

const CREATE_CODE = 'ลับเฉพาะ-2026';

type Body = Record<string, unknown>;

const lin = {
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง ถือย่ามผ้า',
  personality: 'ช่างสังเกต พูดน้อย ขี้ระแวง กลัวความมืด',
};

describe('character: name, appearance, personality + starting values (GEN-047)', { timeout: 60_000 }, () => {
  let createCodeHash = '';
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const clock = Date.UTC(2026, 10, 22, 12, 0, 0);

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

  async function start() {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash },
      // Creating and starting a game need a ready AI GM (GEN-038).
      { now: () => clock, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {} },
    );
    return server;
  }

  async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const res = await fetch(`${server!.url}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as unknown };
  }

  async function createGame(patch: Body = {}) {
    const res = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: false, name: 'นก', pin: '1234', ...patch },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CreateGameResponse.parse(res.body);
  }

  async function joinOk(inviteCode: string, name: string) {
    const res = await call('POST', '/api/join', { body: { inviteCode, name, pin: '1111' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return JoinResponse.parse(res.body);
  }

  const postCharacter = (token: string, body: unknown) => call('POST', '/api/game/character', { token, body });
  const putCharacter = (token: string, body: unknown) => call('PUT', '/api/game/character', { token, body });
  const getCharacter = (token: string) => call('GET', '/api/game/character', { token });

  /** The stored row, including what players never see (karma, the reputation number). */
  const storedRow = (memberId: string) =>
    server!.db.prepare('select * from character where member_id = ?').get(memberId) as Record<string, unknown> | undefined;

  const error = (body: unknown) => ApiError.parse(body);

  it('C1: a complete form saves with HP 100/100, Stamina 30/30, Reputation 0 shown as "คนแปลกหน้า", Karma 0', async () => {
    await start();
    const created = await createGame();

    const res = await postCharacter(created.token, lin);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { character } = CharacterResponse.parse(res.body);
    expect(character).toEqual({
      ...lin,
      hp: { current: 100, max: 100 },
      stamina: { current: 30, max: 30 },
      socialTitle: 'คนแปลกหน้า',
      editable: true,
    });
    expect(storedRow(created.member.id)).toMatchObject({ hp: 100, hp_max: 100, stamina: 30, stamina_max: 30, reputation: 0, karma: 0 });
    // The lobby now counts this player as having a character (GEN-025's start check).
    const view = GameView.parse((await call('GET', '/api/game', { token: created.token })).body);
    expect(view.members[0]?.hasCharacter).toBe(true);
  });

  it('C1: Karma and the Reputation number never reach the player, only the Social Title', async () => {
    await start();
    const created = await createGame();

    const posted = await postCharacter(created.token, lin);
    const got = await getCharacter(created.token);

    for (const res of [posted, got]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/karma|reputation/i);
      expect(text).toContain('คนแปลกหน้า');
    }
  });

  it.each([
    ['name', { name: '' }, 'กรุณาใส่ชื่อจริงของตัวละคร'],
    ['name', { name: '   ' }, 'กรุณาใส่ชื่อจริงของตัวละคร'],
    ['name', { name: 'ก'.repeat(41) }, 'ชื่อจริงยาวได้ไม่เกิน 40 ตัวอักษร'],
    ['appearance', { appearance: '' }, 'กรุณาใส่ลักษณะภายนอก'],
    ['appearance', { appearance: 'ก'.repeat(501) }, 'ลักษณะภายนอกยาวได้ไม่เกิน 500 ตัวอักษร'],
    ['personality', { personality: '' }, 'กรุณาใส่บุคลิก'],
    ['personality', { personality: 'ก'.repeat(1001) }, 'บุคลิกยาวได้ไม่เกิน 1000 ตัวอักษร'],
  ])('C2: %s %j is refused and the field is named', async (field, patch, message) => {
    await start();
    const created = await createGame();

    const res = await postCharacter(created.token, { ...lin, ...patch });

    expect(res.status).toBe(400);
    expect(error(res.body)).toMatchObject({ code: 'invalid_input', fields: { [field]: message } });
    expect(Object.keys((error(res.body) as { fields: object }).fields)).toEqual([field]);
    expect(storedRow(created.member.id)).toBeUndefined();
  });

  it('C2: a missing field is refused and named; the same check applies to edits', async () => {
    await start();
    const created = await createGame();

    const missing = await postCharacter(created.token, { name: 'ลิน' });
    expect(error(missing.body)).toMatchObject({
      code: 'invalid_input',
      fields: { appearance: 'กรุณาใส่ลักษณะภายนอก', personality: 'กรุณาใส่บุคลิก' },
    });

    expect((await postCharacter(created.token, lin)).status).toBe(201);
    const edit = await putCharacter(created.token, { ...lin, name: '' });
    expect(edit.status).toBe(400);
    expect(error(edit.body)).toMatchObject({ fields: { name: 'กรุณาใส่ชื่อจริงของตัวละคร' } });
  });

  it('C2: lengths are Unicode code points: exactly 40 / 500 / 1000 are accepted (Thai marks count)', async () => {
    await start();
    const created = await createGame();
    // 'กิ' is 2 code points (ก + sara i), so 20 of them make exactly 40.
    const body = { name: 'กิ'.repeat(20), appearance: 'ข'.repeat(500), personality: 'ค'.repeat(1000) };

    const res = await postCharacter(created.token, body);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(CharacterResponse.parse(res.body).character).toMatchObject(body);
  });

  it('C2: the name is trimmed and inner spaces folded; text keeps its line breaks', async () => {
    await start();
    const created = await createGame();

    const res = await postCharacter(created.token, {
      name: '  ลิน   ดารา ',
      appearance: ' ผ้าคลุมเทา\nแผลเป็นที่คาง ',
      personality: '\nพูดน้อย\n',
    });

    expect(CharacterResponse.parse(res.body).character).toMatchObject({
      name: 'ลิน ดารา',
      appearance: 'ผ้าคลุมเทา\nแผลเป็นที่คาง',
      personality: 'พูดน้อย',
    });
  });

  it('C3: a second character for the same member in this game is refused; the first one stays', async () => {
    await start();
    const created = await createGame();
    await postCharacter(created.token, lin);

    const res = await postCharacter(created.token, { ...lin, name: 'อีกคน' });

    expect(res.status).toBe(409);
    expect(error(res.body).code).toBe('character_exists');
    expect(CharacterResponse.parse((await getCharacter(created.token)).body).character?.name).toBe('ลิน');
  });

  it('C3: the limit is per member: another player in the same game still creates their own', async () => {
    await start();
    const created = await createGame();
    const bel = await joinOk(created.game.inviteCode, 'เบล');
    await postCharacter(created.token, lin);

    const res = await postCharacter(bel.token, { ...lin, name: 'เบล' });

    expect(res.status).toBe(201);
    expect(CharacterResponse.parse((await getCharacter(bel.token)).body).character?.name).toBe('เบล');
    expect(CharacterResponse.parse((await getCharacter(created.token)).body).character?.name).toBe('ลิน');
  });

  it('C3 (Q-059): the Human GM has no character and cannot create one', async () => {
    await start();
    const created = await createGame({ humanGm: true, name: 'GM' });

    const res = await postCharacter(created.token, lin);

    expect(res.status).toBe(403);
    expect(error(res.body)).toMatchObject({ code: 'forbidden', message: 'GM ไม่มีตัวละคร' });
    expect(storedRow(created.member.id)).toBeUndefined();
  });

  it('C4: hp, stamina, karma and reputation sent by the client are ignored on create and on edit', async () => {
    await start();
    const created = await createGame();
    const cheat = { hp: 1, hpMax: 999, stamina: 999, staminaMax: 999, karma: 99, reputation: 100, socialTitle: 'วีรชนแห่งเมือง' };

    const res = await postCharacter(created.token, { ...lin, ...cheat });

    expect(res.status).toBe(201);
    expect(CharacterResponse.parse(res.body).character).toMatchObject({
      hp: { current: 100, max: 100 },
      stamina: { current: 30, max: 30 },
      socialTitle: 'คนแปลกหน้า',
    });
    const stats = { hp: 100, hp_max: 100, stamina: 30, stamina_max: 30, reputation: 0, karma: 0 };
    expect(storedRow(created.member.id)).toMatchObject(stats);

    const edited = await putCharacter(created.token, { ...lin, name: 'ลินใหม่', ...cheat, hp: { current: 5, max: 5 } });
    expect(edited.status).toBe(200);
    expect(storedRow(created.member.id)).toMatchObject({ ...stats, name: 'ลินใหม่' });
  });

  it('C5: before the start the character can be edited; once the game started, edits are refused', async () => {
    await start();
    const created = await createGame({ mode: 'single' });
    await postCharacter(created.token, lin);

    const before = await putCharacter(created.token, { ...lin, name: 'ลินดา', personality: 'กล้าหาญ' });
    expect(before.status).toBe(200);
    expect(CharacterResponse.parse(before.body).character).toMatchObject({ name: 'ลินดา', personality: 'กล้าหาญ', editable: true });

    expect((await call('POST', '/api/game/start', { token: created.token })).status).toBe(200);

    for (const patch of [{ name: 'ชื่อใหม่' }, { personality: 'บุคลิกใหม่' }, { appearance: 'หน้าตาใหม่' }]) {
      const res = await putCharacter(created.token, { ...lin, name: 'ลินดา', personality: 'กล้าหาญ', ...patch });
      expect(res.status).toBe(409);
      expect(error(res.body).code).toBe('game_started');
    }
    const after = CharacterResponse.parse((await getCharacter(created.token)).body).character;
    expect(after).toMatchObject({ name: 'ลินดา', personality: 'กล้าหาญ', appearance: lin.appearance, editable: false });
  });

  it('C5: editing before creating answers 404', async () => {
    await start();
    const created = await createGame();

    const res = await putCharacter(created.token, lin);

    expect(res.status).toBe(404);
    expect(error(res.body).code).toBe('character_not_found');
  });

  it('C6: the saved character is the same after the server restarts on the same database', async () => {
    await start();
    const created = await createGame();
    expect(CharacterResponse.parse((await getCharacter(created.token)).body)).toEqual({ character: null });
    const saved = CharacterResponse.parse((await postCharacter(created.token, lin)).body);

    await server!.close();
    await start();

    const res = await getCharacter(created.token);
    expect(res.status).toBe(200);
    expect(CharacterResponse.parse(res.body)).toEqual(saved);
  });

  it('needs a session', async () => {
    await start();

    expect((await getCharacter('nope')).status).toBe(401);
    expect((await call('POST', '/api/game/character', { body: lin })).status).toBe(401);
  });
});
