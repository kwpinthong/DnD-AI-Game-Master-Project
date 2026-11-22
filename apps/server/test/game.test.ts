import { ApiError, CreateGameResponse, GameView, JoinResponse, MeResponse } from '@isekai/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultScenario } from '@isekai/protocol';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';

const CREATE_CODE = 'ลับเฉพาะ-2026';
const MINUTE = 60_000;
const MOCK_AI = loadAiConfig({ AI_PROVIDER: 'mock' });
const AI_WITHOUT_KEY = loadAiConfig({ AI_PROVIDER: 'anthropic' });

type Body = Record<string, unknown>;

describe('games: create, members, invite code, kick, start (GEN-025)', { timeout: 60_000 }, () => {
  let createCodeHash = '';
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let clock = Date.UTC(2026, 10, 22, 12, 0, 0);

  beforeAll(async () => {
    createCodeHash = await hashPin(CREATE_CODE);
  });

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    clock = Date.UTC(2026, 10, 22, 12, 0, 0);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** AI_PROVIDER=mock unless a test needs an AI that is not ready (a real provider with no key). */
  async function start(withCreateCode = true, ai = MOCK_AI) {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, ...(withCreateCode ? { createCodeHash } : {}) },
      { now: () => clock, ai, aiLog: () => {} },
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

  const validCreate: Body = {
    createCode: CREATE_CODE,
    gameName: 'เมืองก่อนอุกกาบาต',
    mode: 'online',
    humanGm: false,
    name: 'นก',
    pin: '1234',
  };

  async function createGame(patch: Body = {}) {
    const res = await call('POST', '/api/games', { body: { ...validCreate, ...patch } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CreateGameResponse.parse(res.body);
  }

  async function postJoin(inviteCode: string, name: string, pin = '1111') {
    return call('POST', '/api/join', { body: { inviteCode, name, pin } });
  }

  async function joinOk(inviteCode: string, name: string, pin = '1111') {
    const res = await postJoin(inviteCode, name, pin);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return JoinResponse.parse(res.body);
  }

  async function getGame(token: string) {
    const res = await call('GET', '/api/game', { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return GameView.parse(res.body);
  }

  /** Characters are created by GEN-047 and loot chosen by GEN-073; here both rows are seeded straight in. */
  function seedCharacter(memberId: string) {
    server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(memberId, clock);
    seedChosenLoot(server!.db, memberId);
  }

  const error = (body: unknown) => ApiError.parse(body);

  it('C1: a right create code + Online + Human GM gives an invite code and the creator is the GM', async () => {
    await start();

    const created = await createGame({ humanGm: true, name: 'ต้น' });

    expect(created.game.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.game).toMatchObject({ name: 'เมืองก่อนอุกกาบาต', mode: 'online', humanGm: true, status: 'lobby' });
    expect(created.game.you).toEqual({ memberId: created.member.id, role: 'gm', isOwner: true });
    expect(created.game.members).toEqual([
      { id: created.member.id, name: 'ต้น', role: 'gm', isOwner: true, hasCharacter: false },
    ]);
    // The GM has no character and is not a player.
    expect(created.game.players).toEqual({ count: 0, min: 2, max: 6 });

    // The creator is logged in, and others join with the invite code.
    expect((await call('GET', '/api/me', { token: created.token })).status).toBe(200);
    const player = await joinOk(created.game.inviteCode, 'นก');
    expect(player.member.gameId).toBe(created.game.id);
    const view = await getGame(player.token);
    expect(view.you).toEqual({ memberId: player.member.id, role: 'player', isOwner: false });
    expect(view.players.count).toBe(1);
  });

  // GEN-092: the server reads Thai digits and outer spaces itself, without the web form.
  it('GEN-092 C1/C6: a creator PIN typed in Thai digits is the same PIN as Arabic digits', async () => {
    await start();

    const created = await createGame({ name: 'นก', pin: '๑๒๓๔' });

    const again = await joinOk(created.game.inviteCode, 'นก', '1234');
    expect(again.created).toBe(false);
    expect(again.member.id).toBe(created.member.id);
    expect((await joinOk(created.game.inviteCode, 'นก', ' ๑๒๓๔ ')).member.id).toBe(created.member.id);
  });

  it('GEN-092 C6/C8: joins over the API with Thai digits, and an Arabic PIN still logs in', async () => {
    await start();
    const created = await createGame();

    const first = await joinOk(created.game.inviteCode, 'ต้น', '1111');
    expect((await joinOk(created.game.inviteCode, 'ต้น', '๑๑๑๑')).member.id).toBe(first.member.id);
    expect((await joinOk(created.game.inviteCode, 'ต้น', '1111')).member.id).toBe(first.member.id);

    const thai = await joinOk(created.game.inviteCode, 'ฝน', '๒๒๒๒');
    expect((await joinOk(created.game.inviteCode, 'ฝน', '2222')).member.id).toBe(thai.member.id);

    const refused = await postJoin(created.game.inviteCode, 'ฟ้า', 'ๅ/-ภ');
    expect(refused.status).toBe(400);
    const body = error(refused.body);
    expect(body.code).toBe('invalid_input');
    expect(body.code === 'invalid_input' && body.fields.pin).toContain('แป้นพิมพ์อาจเป็นภาษาไทย');
  });

  it('C1: without a Human GM the creator is the owner and the first player', async () => {
    await start();

    const created = await createGame({ humanGm: false });

    expect(created.game.you).toMatchObject({ role: 'player', isOwner: true });
    expect(created.game.players.count).toBe(1);
  });

  it('C2: Single makes the creator the only player and nobody else can join', async () => {
    await start();

    const created = await createGame({ mode: 'single' });

    expect(created.game).toMatchObject({ mode: 'single', humanGm: false });
    expect(created.game.you).toMatchObject({ role: 'player', isOwner: true });
    expect(created.game.players).toEqual({ count: 1, min: 1, max: 1 });

    const other = await postJoin(created.game.inviteCode, 'เบล');
    expect(other.status).toBe(409);
    expect(error(other.body)).toMatchObject({ code: 'game_full' });
    expect(error(other.body).message).toContain('เกมเต็ม');
    // The creator still logs back in with name + PIN.
    expect((await postJoin(created.game.inviteCode, 'นก', '1234')).status).toBe(200);
  });

  it('C2: Single with a Human GM is refused (Single is AI GM only)', async () => {
    await start();

    const res = await call('POST', '/api/games', { body: { ...validCreate, mode: 'single', humanGm: true } });

    expect(res.status).toBe(400);
    expect(error(res.body)).toMatchObject({ code: 'invalid_input', fields: { humanGm: expect.any(String) } });
  });

  it('C3: a wrong create code is refused with "create code ไม่ถูกต้อง" and no game is made', async () => {
    await start();

    const res = await call('POST', '/api/games', { body: { ...validCreate, createCode: 'เดาเอา' } });

    expect(res.status).toBe(403);
    expect(error(res.body)).toEqual({ code: 'wrong_create_code', message: 'create code ไม่ถูกต้อง' });
    expect((server!.db.prepare('select count(*) as n from game').get() as { n: number }).n).toBe(0);
  });

  it('C3: an empty or missing create code is refused at the createCode field', async () => {
    await start();

    for (const createCode of ['', undefined]) {
      const res = await call('POST', '/api/games', { body: { ...validCreate, createCode } });
      expect(res.status).toBe(400);
      expect(error(res.body)).toMatchObject({ code: 'invalid_input', fields: { createCode: 'กรุณาใส่ create code' } });
    }
    expect((server!.db.prepare('select count(*) as n from game').get() as { n: number }).n).toBe(0);
  });

  it('C3: a server without CREATE_CODE_HASH refuses every create code', async () => {
    await start(false);

    const res = await call('POST', '/api/games', { body: validCreate });

    expect(res.status).toBe(503);
    expect(error(res.body).code).toBe('create_disabled');
  });

  it('C3: 10 wrong create codes in 10 minutes block creating for 10 minutes, even with the right code', async () => {
    await start();
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/api/games', { body: { ...validCreate, createCode: `ผิด${i}` } })).status).toBe(403);
    }

    const blocked = await call('POST', '/api/games', { body: validCreate });
    expect(blocked.status).toBe(429);
    expect(error(blocked.body)).toMatchObject({ code: 'too_many_attempts' });

    clock += 10 * MINUTE;
    expect((await call('POST', '/api/games', { body: validCreate })).status).toBe(200);
  });

  it('C4: Online with 6 players refuses the 7th with "เกมเต็ม"; a returning player still gets in', async () => {
    await start();
    const created = await createGame({ humanGm: true, name: 'GM' });
    const code = created.game.inviteCode;
    for (const name of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await joinOk(code, name);

    const seventh = await postJoin(code, 'p7');

    expect(seventh.status).toBe(409);
    expect(error(seventh.body)).toMatchObject({ code: 'game_full' });
    expect(error(seventh.body).message).toContain('เกมเต็ม');
    expect((await postJoin(code, 'p3')).status).toBe(200);
    expect((await getGame(created.token)).players).toEqual({ count: 6, min: 2, max: 6 });
  });

  it('C4: without a Human GM the creator is one of the 6 players', async () => {
    await start();
    const created = await createGame();
    for (const name of ['p2', 'p3', 'p4', 'p5', 'p6']) await joinOk(created.game.inviteCode, name);

    expect(error((await postJoin(created.game.inviteCode, 'p7')).body).code).toBe('game_full');
  });

  it('C5: Online with 1 player cannot start and says how many players are missing', async () => {
    await start();
    const created = await createGame();
    seedCharacter(created.member.id);

    const res = await call('POST', '/api/game/start', { token: created.token });

    expect(res.status).toBe(409);
    const body = error(res.body);
    expect(body.code).toBe('cannot_start');
    expect(body).toMatchObject({ reasons: ['ขาดผู้เล่นอีก 1 คน (Online ต้องมีผู้เล่นอย่างน้อย 2 คน)'] });
    expect((await getGame(created.token)).status).toBe('lobby');
  });

  it('C5: a player without a character blocks the start and is named; the GM needs no character', async () => {
    await start();
    const created = await createGame({ humanGm: true, name: 'GM' });
    const bel = await joinOk(created.game.inviteCode, 'เบล');
    const ton = await joinOk(created.game.inviteCode, 'ต้น');
    const pla = await joinOk(created.game.inviteCode, 'ปลา');
    seedCharacter(bel.member.id);

    const res = await call('POST', '/api/game/start', { token: created.token });

    expect(res.status).toBe(409);
    expect(error(res.body)).toMatchObject({ code: 'cannot_start', reasons: ['ยังไม่สร้างตัวละคร: ต้น, ปลา'] });
    const view = await getGame(created.token);
    expect(view.startBlockers).toEqual(['ยังไม่สร้างตัวละคร: ต้น, ปลา']);
    expect(view.members.find((m) => m.id === bel.member.id)?.hasCharacter).toBe(true);

    seedCharacter(ton.member.id);
    seedCharacter(pla.member.id);
    const started = await call('POST', '/api/game/start', { token: created.token });
    expect(started.status).toBe(200);
    expect(GameView.parse(started.body)).toMatchObject({ status: 'started', startBlockers: [] });
  });

  it('Q-144: a player with a character but no loot choice (or an old Common one) blocks the start and is named', async () => {
    await start();
    const created = await createGame({ humanGm: true, name: 'GM' });
    const bel = await joinOk(created.game.inviteCode, 'เบล');
    const ton = await joinOk(created.game.inviteCode, 'ต้น');
    const pla = await joinOk(created.game.inviteCode, 'ปลา');
    for (const p of [bel, ton, pla]) server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(p.member.id, clock);
    seedChosenLoot(server!.db, bel.member.id);
    seedChosenLoot(server!.db, ton.member.id, { legacy: true });

    const res = await call('POST', '/api/game/start', { token: created.token });
    expect(res.status).toBe(409);
    expect(error(res.body)).toMatchObject({ code: 'cannot_start', reasons: ['ยังไม่ได้เลือกของติดตัว: ต้น, ปลา'] });
    expect((await getGame(created.token)).startBlockers).toEqual(['ยังไม่ได้เลือกของติดตัว: ต้น, ปลา']);
    expect((await getGame(created.token)).status).toBe('lobby');

    // An offer on the table is not a choice yet.
    server!.db.prepare("update character_loot set offer_json = '{}' where member_id = ?").run(ton.member.id);
    seedChosenLoot(server!.db, ton.member.id);
    expect((await getGame(created.token)).startBlockers).toEqual(['ยังไม่ได้เลือกของติดตัว: ปลา']);

    seedChosenLoot(server!.db, pla.member.id);
    const started = await call('POST', '/api/game/start', { token: created.token });
    expect(started.status).toBe(200);
    expect(GameView.parse(started.body)).toMatchObject({ status: 'started', startBlockers: [] });
  });

  it('Q-144: a player with no character is named once, under the character blocker only', async () => {
    await start();
    const created = await createGame({ mode: 'single' });
    expect((await getGame(created.token)).startBlockers).toEqual(['ยังไม่สร้างตัวละคร: นก']);
    server!.db.prepare('insert into character (member_id, created_at) values (?, ?)').run(created.member.id, clock);
    expect((await getGame(created.token)).startBlockers).toEqual(['ยังไม่ได้เลือกของติดตัว: นก']);
  });

  it('C5: Single starts once its one player has a character', async () => {
    await start();
    const created = await createGame({ mode: 'single' });
    expect(error((await call('POST', '/api/game/start', { token: created.token })).body)).toMatchObject({
      reasons: ['ยังไม่สร้างตัวละคร: นก'],
    });

    seedCharacter(created.member.id);

    expect((await call('POST', '/api/game/start', { token: created.token })).status).toBe(200);
  });

  it('C6: a new invite code replaces the old one; members get back in with it and the same name + PIN', async () => {
    await start();
    const created = await createGame();
    const oldCode = created.game.inviteCode;
    const bel = await joinOk(oldCode, 'เบล', '5555');

    const res = await call('POST', '/api/game/invite-code', { token: created.token });

    expect(res.status).toBe(200);
    const newCode = GameView.parse(res.body).inviteCode;
    expect(newCode).not.toBe(oldCode);
    expect(newCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(error((await postJoin(oldCode, 'เบล', '5555')).body).code).toBe('game_not_found');
    const back = await joinOk(newCode, 'เบล', '5555');
    expect(back.created).toBe(false);
    expect(back.member.id).toBe(bel.member.id);
    // Sessions opened before the change stay valid.
    expect((await call('GET', '/api/me', { token: bel.token })).status).toBe(200);
  });

  it('C7: a kicked member loses every session and cannot join again with the same name + PIN', async () => {
    await start();
    const created = await createGame();
    const bel = await joinOk(created.game.inviteCode, 'เบล', '5555');
    const belPhone = await joinOk(created.game.inviteCode, 'เบล', '5555');

    const res = await call('DELETE', `/api/game/members/${bel.member.id}`, { token: created.token });

    expect(res.status).toBe(200);
    expect(GameView.parse(res.body).members.map((m) => m.name)).toEqual(['นก']);
    expect((await call('GET', '/api/me', { token: bel.token })).status).toBe(401);
    expect((await call('GET', '/api/me', { token: belPhone.token })).status).toBe(401);
    expect((await call('GET', '/api/game', { token: bel.token })).status).toBe(401);
    const again = await postJoin(created.game.inviteCode, 'เบล', '5555');
    expect(again.status).toBe(403);
    expect(error(again.body).code).toBe('kicked');
  });

  it('C7: a member who is not the owner gets 403 for kick, edit, new invite code and start', async () => {
    await start();
    const created = await createGame();
    const bel = await joinOk(created.game.inviteCode, 'เบล');

    const attempts = [
      await call('DELETE', `/api/game/members/${created.member.id}`, { token: bel.token }),
      await call('DELETE', `/api/game/members/${bel.member.id}`, { token: bel.token }),
      await call('PATCH', '/api/game', { token: bel.token, body: { mode: 'single' } }),
      await call('PATCH', '/api/game', { token: bel.token, body: { gameName: 'ของฉัน' } }),
      await call('POST', '/api/game/invite-code', { token: bel.token }),
      await call('POST', '/api/game/start', { token: bel.token }),
    ];

    for (const res of attempts) {
      expect(res.status).toBe(403);
      expect(error(res.body).code).toBe('forbidden');
    }
    const view = await getGame(created.token);
    expect(view).toMatchObject({ name: 'เมืองก่อนอุกกาบาต', mode: 'online', inviteCode: created.game.inviteCode, status: 'lobby' });
    expect(view.members).toHaveLength(2);
  });

  it('C7: the owner cannot kick a member of another game, and requests without a session get 401', async () => {
    await start();
    const a = await createGame();
    const b = await createGame({ gameName: 'อีกเกม' });

    const res = await call('DELETE', `/api/game/members/${b.member.id}`, { token: a.token });

    expect(res.status).toBe(404);
    expect((await call('GET', '/api/me', { token: b.token })).status).toBe(200);
    expect((await call('POST', '/api/game/start')).status).toBe(401);
    expect((await call('PATCH', '/api/game', { body: { mode: 'single' } })).status).toBe(401);
  });

  it('C8: after the start, mode cannot change, nobody new can join, and nobody can be kicked', async () => {
    await start();
    const created = await createGame();
    const bel = await joinOk(created.game.inviteCode, 'เบล', '5555');
    seedCharacter(created.member.id);
    seedCharacter(bel.member.id);
    expect((await call('POST', '/api/game/start', { token: created.token })).status).toBe(200);

    const modeChange = await call('PATCH', '/api/game', { token: created.token, body: { mode: 'single' } });
    const newcomer = await postJoin(created.game.inviteCode, 'ปลา');
    const kick = await call('DELETE', `/api/game/members/${bel.member.id}`, { token: created.token });
    const startAgain = await call('POST', '/api/game/start', { token: created.token });

    for (const res of [modeChange, newcomer, kick, startAgain]) {
      expect(res.status).toBe(409);
      expect(error(res.body).code).toBe('game_started');
    }
    expect(error(newcomer.body).message).toBe('เกมนี้เริ่มไปแล้ว รับคนเพิ่มไม่ได้');
    const view = await getGame(created.token);
    expect(view.mode).toBe('online');
    expect(view.members.map((m) => m.name)).toEqual(['นก', 'เบล']);
    // Members of a started game still log back in.
    expect((await postJoin(created.game.inviteCode, 'เบล', '5555')).status).toBe(200);
  });

  it('before the start the owner can rename the game and switch mode when the players fit', async () => {
    await start();
    const created = await createGame();

    const renamed = await call('PATCH', '/api/game', { token: created.token, body: { gameName: 'ป่าหลังเมือง', mode: 'single' } });
    expect(renamed.status).toBe(200);
    expect(GameView.parse(renamed.body)).toMatchObject({ name: 'ป่าหลังเมือง', mode: 'single', players: { max: 1 } });

    await call('PATCH', '/api/game', { token: created.token, body: { mode: 'online' } });
    await joinOk(created.game.inviteCode, 'เบล');
    const tooMany = await call('PATCH', '/api/game', { token: created.token, body: { mode: 'single' } });
    expect(tooMany.status).toBe(409);
    expect(error(tooMany.body).code).toBe('not_allowed');
  });

  it('the owner cannot kick themselves', async () => {
    await start();
    const created = await createGame();

    const res = await call('DELETE', `/api/game/members/${created.member.id}`, { token: created.token });

    expect(res.status).toBe(409);
    expect(error(res.body).code).toBe('not_allowed');
    expect(MeResponse.parse((await call('GET', '/api/me', { token: created.token })).body).member.id).toBe(created.member.id);
  });

  it('Q-070: creating a game copies the default scenario; each game gets its own copy', async () => {
    await start();
    const a = await createGame();
    const b = await createGame({ gameName: 'เกมที่สอง' });
    const orm = server!.orm;
    expect(getGameScenario(orm, a.game.id)).toEqual(defaultScenario());
    expect(getGameScenario(orm, b.game.id)).toEqual(defaultScenario());

    const edited = { ...defaultScenario(), name: 'แก้เฉพาะเกม A' };
    expect(updateGameScenario(orm, a.game.id, edited).ok).toBe(true);
    expect(getGameScenario(orm, a.game.id)?.name).toBe('แก้เฉพาะเกม A');
    expect(getGameScenario(orm, b.game.id)).toEqual(defaultScenario());
  });

  it('Q-075: without a ready AI (no ANTHROPIC_API_KEY) creating a game is refused with the Thai reason', async () => {
    await start(true, AI_WITHOUT_KEY);
    const res = await call('POST', '/api/games', { body: validCreate });
    expect(res.status).toBe(503);
    expect(error(res.body)).toMatchObject({ code: 'ai_not_ready', message: expect.stringMatching(/ANTHROPIC_API_KEY.*สร้างหรือเริ่มเกม/) });
    expect(server!.db.prepare('select count(*) as n from game').get()).toEqual({ n: 0 });
  });

  it('Q-075: without a ready AI the owner cannot start a game that could otherwise start', async () => {
    await start();
    const created = await createGame({ mode: 'single' });
    seedCharacter(created.member.id);
    await server!.close();
    await start(true, AI_WITHOUT_KEY);

    const res = await call('POST', '/api/game/start', { token: created.token });
    expect(res.status).toBe(503);
    expect(error(res.body)).toMatchObject({ code: 'ai_not_ready', message: expect.stringMatching(/สร้างหรือเริ่มเกม/) });
    expect((await getGame(created.token)).status).toBe('lobby');
  });
});
