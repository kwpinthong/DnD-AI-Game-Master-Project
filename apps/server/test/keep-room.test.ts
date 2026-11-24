import { ApiError, CharacterResponse, CreateGameResponse, GameLogResponse, GameView, JoinResponse, MeResponse } from '@isekai/protocol';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeGame } from '../src/admin/games.ts';
import { SESSION_TTL_MS } from '../src/auth/join.ts';
import type { PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer, ServerOptions } from '../src/server.ts';
import { makeTempDir, seedChosenLoot, withLooks } from './helpers.ts';
import { NARA, sendAction } from './resume-fixture.ts';
import { isReady, isRoom, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, startedTable, startTestServer, type Call } from './visibility-fixture.ts';

/**
 * ISK-021: a game is never lost. Nothing removes a game by age, a session slides 30 days from its last use, a token
 * the server no longer knows is 401 `session_expired`, and an old member's name + PIN brings back the same member in
 * every phase (lobby, setup, playing, ended, closed).
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PIN = '1111';
const TAN = { name: 'ตาล', appearance: 'ชายผมหยิกสะพายย่าม', personality: 'พูดเก่ง ขี้เล่น' };
const FAH = { name: 'ฟ้า', appearance: 'หญิงตัวเล็กตาคม', personality: 'เงียบ ระวังตัว' };

describe('ISK-021 the game room is kept', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let clock = CLOCK;
  let sockets: RoomClient[] = [];
  let call: Call;

  async function boot(options: ServerOptions = {}) {
    server = await startTestServer(dir, { now: () => clock, ...options });
    call = caller(server);
  }
  async function restart(options: ServerOptions = {}) {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot(options);
  }

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    clock = CLOCK;
    await boot();
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function enter(token: string): Promise<RoomClient> {
    const c = await openRoom(server!, { token });
    sockets.push(c);
    await c.waitFor(isReady);
    return c;
  }
  async function rejoin(inviteCode: string, name: string, pin = PIN) {
    return call('POST', '/api/join', { body: { inviteCode, name, pin } });
  }
  async function rejoined(inviteCode: string, name: string) {
    const res = await rejoin(inviteCode, name);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return JoinResponse.parse(res.body);
  }
  const db = () => server!.db;
  const expiresOf = (memberId: string) => (db().prepare('select max(expires_at) as at from session where member_id = ?').get(memberId) as { at: number }).at;
  const memberCount = (inviteCode: string) =>
    (db().prepare('select count(*) as n from member m join game g on g.id = m.game_id where g.invite_code = ?').get(inviteCode) as { n: number }).n;
  const gameIdOf = (memberId: string) => (db().prepare('select game_id as id from member where id = ?').get(memberId) as { id: string }).id;
  const characterOf = (memberId: string) => db().prepare('select * from character where member_id = ?').get(memberId);
  const atPlay = (gameId: string, extra: Record<string, unknown> = {}) =>
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, clock), day: 4, phase: 'EOSORIA', turn: 1, status: 'collecting', submissions: {}, ...extra }, clock);

  /** A started online game with all 6 seats taken: นก (owner) + บี ซี ดี อี เอฟ. */
  async function fullTable() {
    const created = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'ห้องเต็ม', mode: 'online', humanGm: false, name: 'นก', pin: PIN } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const game = CreateGameResponse.parse(created.body);
    const seats = [{ token: game.token, memberId: game.member.id, name: 'นก' }];
    for (const name of ['บี', 'ซี', 'ดี', 'อี', 'เอฟ']) {
      const j = await rejoined(game.game.inviteCode, name);
      seats.push({ token: j.token, memberId: j.member.id, name });
    }
    for (const [i, seat] of seats.entries()) {
      const res = await call('POST', '/api/game/character', { token: seat.token, body: withLooks([LIN, DARIN, MEKHA, NARA, TAN, FAH][i]!) });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      CharacterResponse.parse(res.body);
      seedChosenLoot(db(), seat.memberId);
    }
    // ISK-017: the game starts when every player is ready.
    for (const seat of seats) expect((await call('POST', '/api/game/ready', { token: seat.token, body: { ready: true } })).status).toBe(200);
    return { inviteCode: game.game.inviteCode, gameId: game.game.id, seats };
  }

  it('C1: nobody plays for 365 days: the game is still there, and an old member joins with name + PIN and plays on', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.b.memberId);
    atPlay(gameId);
    clock += 365 * DAY;
    await restart();

    const old = await call('GET', '/api/game', { token: t.b.token });
    expect(old.status).toBe(401);
    expect(ApiError.parse(old.body).code).toBe('session_expired');

    const back = await rejoined(t.inviteCode, 'บี');
    expect(back).toMatchObject({ created: false, member: { id: t.b.memberId } });
    expect(GameView.parse((await call('GET', '/api/game', { token: back.token })).body).id).toBe(gameId);
    const b = await enter(back.token);
    expect(b.messages.filter(isRoom).at(-1)).toMatchObject({ day: 4, phase: 'EOSORIA', turn: 1, status: 'collecting' });
    expect(await sendAction(b, 'กลับมาเดินตลาดอีกครั้ง')).toEqual({ type: 'action_accepted' });
  });

  it('C2: a session used on day 29 lasts 30 more days; 10 requests within the hour write its expiry once', async () => {
    const t = await startedTable(server!, false);
    expect(expiresOf(t.b.memberId)).toBe(CLOCK + SESSION_TTL_MS);

    clock = CLOCK + 29 * DAY;
    expect((await call('GET', '/api/me', { token: t.b.token })).status).toBe(200);
    const renewed = clock + SESSION_TTL_MS;
    expect(expiresOf(t.b.memberId)).toBe(renewed);

    // 10 requests in the next 59 minutes: the expiry stays what the first one wrote (no write per request).
    for (let i = 1; i <= 10; i++) {
      clock += 5 * 60_000 + 54_000;
      expect((await call('GET', '/api/game', { token: t.b.token })).status).toBe(200);
      expect(expiresOf(t.b.memberId)).toBe(renewed);
    }

    // It now works past the first 30 days, and an hour after the last write the next request slides it again.
    clock = CLOCK + 31 * DAY;
    expect(MeResponse.parse((await call('GET', '/api/me', { token: t.b.token })).body).member.id).toBe(t.b.memberId);
    expect(expiresOf(t.b.memberId)).toBe(clock + SESSION_TTL_MS);
  });

  it('C3: an expired or unknown session is 401 session_expired; no token at all stays 401 unauthorized', async () => {
    const t = await startedTable(server!, false);
    clock = CLOCK + SESSION_TTL_MS;
    for (const path of ['/api/game', '/api/me', '/api/game/log', '/api/game/character']) {
      const res = await call('GET', path, { token: t.b.token });
      expect(res.status, path).toBe(401);
      expect(ApiError.parse(res.body).code, path).toBe('session_expired');
    }
    const unknown = await call('GET', '/api/game', { token: 'no-such-token' });
    expect(unknown.status).toBe(401);
    expect(ApiError.parse(unknown.body).code).toBe('session_expired');
    const none = await call('GET', '/api/game');
    expect(none.status).toBe(401);
    expect(ApiError.parse(none.body).code).toBe('unauthorized');
  });

  it('C4: in a full game mid-play, an old member with name + PIN is the same member, character, place and action; no seat is added', async () => {
    const t = await fullTable();
    atPlay(t.gameId);
    const b = t.seats[1]!;
    const before = await enter(b.token);
    expect(await sendAction(before, 'ถามทางไปท่าเรือ')).toEqual({ type: 'action_accepted' });
    const was = before.messages.filter(isRoom).at(-1)!.you;
    const character = characterOf(b.memberId);
    await before.close();

    const back = await rejoined(t.inviteCode, 'บี');
    expect(back).toMatchObject({ created: false, member: { id: b.memberId } });
    expect(memberCount(t.inviteCode)).toBe(6);
    expect(characterOf(b.memberId)).toEqual(character);
    const after = await enter(back.token);
    const now = after.messages.filter(isRoom).at(-1)!.you;
    expect(now).toMatchObject({ memberId: b.memberId, place: was.place, action: { text: 'ถามทางไปท่าเรือ' } });

    // Lobby and setup work the same way (no seat, same member).
    const lobby = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'ห้องรอ', mode: 'online', humanGm: false, name: 'นก', pin: PIN } });
    const code = CreateGameResponse.parse(lobby.body).game.inviteCode;
    const first = await rejoined(code, 'บี');
    expect(await rejoined(code, 'บี')).toMatchObject({ created: false, member: { id: first.member.id } });
    expect(memberCount(code)).toBe(2);
    const setup = await startedTable(server!, false, { gameName: 'ตั้งตัว' });
    expect(await rejoined(setup.inviteCode, 'ซี')).toMatchObject({ created: false, member: { id: setup.c.memberId } });
  });

  it('C5: a wrong PIN is still 401 wrong_pin, and a kicked name is still 403 kicked (regression)', async () => {
    const t = await startedTable(server!, false);
    const wrong = await rejoin(t.inviteCode, 'บี', '9999');
    expect(wrong.status).toBe(401);
    expect(ApiError.parse(wrong.body)).toMatchObject({ code: 'wrong_pin', attemptsLeft: 4 });

    const created = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'เตะ', mode: 'online', humanGm: false, name: 'นก', pin: PIN } });
    const game = CreateGameResponse.parse(created.body);
    const b = await rejoined(game.game.inviteCode, 'บี');
    // ISK-017 removed the owner's kick; the stored kick is what a join reads (ISK-018's admin kick writes the same).
    db().prepare('update member set kicked_at = 1 where id = ?').run(b.member.id);
    const kicked = await rejoin(game.game.inviteCode, 'บี');
    expect(kicked.status).toBe(403);
    expect(ApiError.parse(kicked.body).code).toBe('kicked');
  });

  it('C6: an ended game and a closed game: old members join back, read the summary and history, and cannot act', async () => {
    const ended = await startedTable(server!, false, { gameName: 'จบแล้ว' });
    atPlay(gameIdOf(ended.b.memberId), { day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' });
    const closed = await startedTable(server!, false, { gameName: 'ปิดแล้ว' });
    const closedId = gameIdOf(closed.b.memberId);
    atPlay(closedId);
    expect(closeGame(server!.orm, closedId, { confirmName: 'ปิดแล้ว' }, clock).kind).toBe('closed');

    for (const t of [ended, closed]) {
      const back = await rejoined(t.inviteCode, 'บี');
      expect(back).toMatchObject({ created: false, member: { id: t.b.memberId } });
      const log = await call('GET', '/api/game/log', { token: back.token });
      expect(log.status, JSON.stringify(log.body)).toBe(200);
      GameLogResponse.parse(log.body);
      const room = await enter(back.token);
      expect(room.messages.filter(isRoom).at(-1)!.you.lock?.code).toBe('game_ended');
      const from = room.messages.length;
      room.action('ยังอยากเล่นต่อ', 'public');
      expect(await room.waitFor((m) => m.type === 'action_rejected' || m.type === 'error', from)).toMatchObject(
        t === ended ? { type: 'action_rejected', code: 'game_ended' } : { type: 'error', code: 'game_closed' },
      );
    }
  });

  it('C7: a restart while the turn waits for the AI: the turn goes on after the restart and no action is lost', async () => {
    const waiting: PhaseResolver = {
      resolve: ({ signal }) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('shutdown')), { once: true })),
    };
    await restart({ phaseResolver: waiting });
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t.a.memberId);
    const clients = [await enter(t.a.token), await enter(t.b.token), await enter(t.c.token)];
    for (const [i, c] of clients.entries()) expect(await sendAction(c, ['ซื้อขนมปัง', 'ถามข่าว', 'ช่วยยกของ'][i]!)).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor((m) => isRoom(m) && m.status === 'resolving');

    await restart();
    const stored = db().prepare('select count(*) as n from phase_action where game_id = ?').get(gameId) as { n: number };
    expect(stored.n).toBe(3);
    const a = await enter(t.a.token);
    // "goes on or waits for a retry": a stuck turn is retried once by a member.
    if (a.messages.filter(isRoom).at(-1)!.gmStatus?.code === 'stuck') a.send({ type: 'retry' });
    await a.waitFor((m) => isRoom(m) && m.turn === 2 && m.status === 'collecting');
  });

  it('C8: no job or query removes a game by time: the only game delete is the owner\'s confirmed delete, the only timers are backup + learning', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => join(src, f));
    const hits = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f).replaceAll('\\', '/')).sort();

    expect(hits(/setInterval\(|node-cron|\bcron\b/)).toEqual(['backup/schedule.ts', 'learning/extract.ts']);
    for (const file of ['backup/schedule.ts', 'learning/extract.ts']) {
      expect(readFileSync(join(src, file), 'utf8'), file).not.toMatch(/\.delete\(\s*(game|member)\b|delete\s+from\s+(game|member)\b/i);
    }
    expect(hits(/\.delete\(\s*game\s*\)|delete\s+from\s+"?game"?\s/i)).toEqual(['game/service.ts']);
    const service = readFileSync(join(src, 'game', 'service.ts'), 'utf8');
    expect(service.match(/\.delete\(\s*game\s*\)/g)).toHaveLength(1);
    // ISK-017: no route calls deleteGame any more (players cannot delete a game).
    expect(hits(/\bdeleteGame\(/)).toEqual(['game/service.ts']);
    expect(service.match(/\bdeleteGame\(/g)).toHaveLength(1);
  });
});
