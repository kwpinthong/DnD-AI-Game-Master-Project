import { ApiError, GameLogResponse, GameView, JoinResponse, defaultScenario, sortTimeline } from '@isekai/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeGame } from '../src/admin/games.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { migrationsFolder } from '../src/db/client.ts';
import { blockMember } from '../src/game/service.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import type { RunningServer, ServerOptions } from '../src/server.ts';
import { makeTempDir, seedChosenLoot } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, DARIN, LIN, MEKHA, readyAll, startedTable, startTestServer, type Call, type Table } from './visibility-fixture.ts';

/**
 * ISK-023: after the end, every player of the room's latest round presses "เล่นรอบใหม่"; the server then makes the
 * next round of the same room (same invite code, settings and members, new characters) once, and each member gets
 * their new round's token from any of their round tokens. The old round stays as history.
 */

const AI_WITHOUT_KEY = loadAiConfig({ AI_PROVIDER: 'anthropic' });
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };

interface Seat {
  token: string;
  memberId: string;
}

describe('ISK-023 a new round in the same room', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
  const sockets: RoomClient[] = [];

  async function boot(options: ServerOptions = {}) {
    server = await startTestServer(dir, options);
    call = caller(server);
  }

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    await boot();
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function reboot(options: ServerOptions = {}) {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    await boot(options);
  }

  const gameOf = (memberId: string) => (server!.db.prepare('select game_id as id from member where id = ?').get(memberId) as { id: string }).id;
  const nextRounds = (gameId: string) => server!.db.prepare('select * from game where previous_game_id = ?').all(gameId) as Record<string, unknown>[];
  const namesIn = (gameId: string) => (server!.db.prepare('select name from member where game_id = ? order by created_at, rowid').all(gameId) as { name: string }[]).map((r) => r.name);

  function end(gameId: string) {
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), status: 'finale' }, CLOCK);
  }

  /** A started online table (นก / บี / ซี, Human GM optional) that ended at its finale. */
  async function endedTable(humanGm = false, extra: Record<string, unknown> = {}): Promise<Table & { gameId: string; seats: Seat[] }> {
    const t = await startedTable(server!, humanGm, extra);
    const gameId = gameOf(t.a.memberId);
    end(gameId);
    return { ...t, gameId, seats: [t.a, t.b, t.c] };
  }

  const rematch = (seat: Seat, ready: unknown = true) => call('POST', '/api/game/rematch-ready', { token: seat.token, body: { ready } });
  const session = (seat: Seat) => call('POST', '/api/game/rematch/session', { token: seat.token });
  const view = async (seat: Seat) => {
    const res = await call('GET', '/api/game', { token: seat.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return GameView.parse(res.body);
  };
  const rematchReadyOf = async (seat: Seat) => Object.fromEntries((await view(seat)).members.map((m) => [m.id, m.rematchReady]));

  async function newSeat(seat: Seat): Promise<Seat> {
    const res = await session(seat);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const joined = JoinResponse.parse(res.body);
    return { token: joined.token, memberId: joined.member.id };
  }

  async function roomSocket(seat: Seat): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function expectOk(res: Promise<{ status: number; body: unknown }>) {
    const done = await res;
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return GameView.parse(done.body);
  }

  async function expectError(res: Promise<{ status: number; body: unknown }>, status: number, code: string) {
    const done = await res;
    expect(done.status, JSON.stringify(done.body)).toBe(status);
    expect(ApiError.parse(done.body).code).toBe(code);
    return ApiError.parse(done.body);
  }

  it('C1: an online game ended at its finale, 3 players all ready: one new round, roundNo 2, the same 3 names, everyone hears rematch_started', async () => {
    const t = await endedTable();
    const watchers = [await roomSocket(t.a), await roomSocket(t.b), await roomSocket(t.c)];
    for (const seat of t.seats) await expectOk(rematch(seat));

    const rounds = nextRounds(t.gameId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round_no: 2, previous_game_id: t.gameId });
    const newId = rounds[0]!.id as string;
    expect(namesIn(newId)).toEqual(['นก', 'บี', 'ซี']);
    for (const w of watchers) {
      expect(await w.waitFor((m) => m.type === 'rematch_started')).toEqual({ type: 'rematch_started', gameId: newId });
      for (const seat of t.seats) await w.waitFor((m) => m.type === 'rematch_ready' && m.memberId === seat.memberId && m.ready);
    }
  });

  it('C2: 2 of 3 ready makes no round; one takes it back: their ready is false again', async () => {
    const t = await endedTable();
    const watcher = await roomSocket(t.c);
    await expectOk(rematch(t.a));
    const second = await expectOk(rematch(t.b));
    expect(second.round).toEqual({ roundNo: 1, previousGameId: null, latestGameId: null });
    expect(nextRounds(t.gameId)).toEqual([]);

    const back = await expectOk(rematch(t.b, false));
    expect(back.members.find((m) => m.id === t.b.memberId)?.rematchReady).toBe(false);
    await watcher.waitFor((m) => m.type === 'rematch_ready' && m.memberId === t.b.memberId && !m.ready);
    expect(await rematchReadyOf(t.c)).toEqual({ [t.a.memberId]: true, [t.b.memberId]: false, [t.c.memberId]: false });
    await expectOk(rematch(t.c));
    expect(nextRounds(t.gameId)).toEqual([]);
    await expectError(rematch(t.a, 'yes'), 400, 'invalid_input');
  });

  it('C3: a game still being played is 409 not_ended; nothing changes', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameOf(t.a.memberId);
    await expectError(rematch(t.a), 409, 'not_ended');
    expect((server!.db.prepare('select rematch_ready_at as r from member where id = ?').get(t.a.memberId) as { r: number | null }).r).toBeNull();
    expect(nextRounds(gameId)).toEqual([]);
  });

  it('C4: the last two ready at the same time make one new round', async () => {
    const t = await endedTable();
    await expectOk(rematch(t.a));
    const both = await Promise.all([rematch(t.b), rematch(t.c)]);
    for (const res of both) expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(nextRounds(t.gameId)).toHaveLength(1);
    expect((server!.db.prepare('select count(*) as n from game').get() as { n: number }).n).toBe(2);
  });

  it('C5: after rematch_started the old token gets the new member\'s token; GET /api/game is the new round at character creation; it starts at day 1', async () => {
    const t = await endedTable();
    const watcher = await roomSocket(t.a);
    for (const seat of t.seats) await expectOk(rematch(seat));
    const started = await watcher.waitFor((m) => m.type === 'rematch_started');
    const newId = (started as { gameId: string }).gameId;

    const seats = [await newSeat(t.a), await newSeat(t.b), await newSeat(t.c)];
    for (const [i, seat] of seats.entries()) {
      expect(gameOf(seat.memberId)).toBe(newId);
      expect(seat.memberId).not.toBe(t.seats[i]!.memberId);
    }
    const fresh = await view(seats[0]!);
    expect(fresh).toMatchObject({ id: newId, status: 'lobby', round: { roundNo: 2, previousGameId: t.gameId, latestGameId: null }, inviteCode: t.inviteCode });
    expect(fresh.members.map((m) => [m.name, m.hasCharacter, m.ready, m.rematchReady])).toEqual([
      ['นก', false, false, false],
      ['บี', false, false, false],
      ['ซี', false, false, false],
    ]);
    expect(fresh.startBlockers.join(' ')).toContain('ยังไม่สร้างตัวละคร');
    // The world has not begun: no engine state yet.
    expect(server!.db.prepare('select * from game_phase where game_id = ?').get(newId)).toBeUndefined();

    for (const [i, identity] of [LIN, DARIN, MEKHA].entries()) {
      const res = await call('POST', '/api/game/character', { token: seats[i]!.token, body: identity });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      seedChosenLoot(server!.db, seats[i]!.memberId);
    }
    await readyAll(call, seats);
    // The engine state is made when the first player enters the room.
    await roomSocket(seats[0]!);
    const log = GameLogResponse.parse((await call('GET', '/api/game/log', { token: seats[0]!.token })).body);
    expect(log.game).toMatchObject({ id: newId, status: 'playing', at: { day: 1, phase: 'EOSORIA', turn: 1 } });
  });

  it('C6: the old token still opens the old end page and history; rematch-ready on the old round after the new one = 409 not_latest_round', async () => {
    const t = await endedTable();
    const before = (await call('GET', '/api/game/log', { token: t.a.token })).body;
    const learning = () => server!.db.prepare('select * from learning_entry where source_game_id = ?').all(t.gameId);
    const learningBefore = learning();
    for (const seat of t.seats) await expectOk(rematch(seat));
    const newId = nextRounds(t.gameId)[0]!.id as string;

    const after = await call('GET', '/api/game/log', { token: t.a.token });
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before);
    expect(GameLogResponse.parse(after.body).game).toMatchObject({ id: t.gameId, status: 'ended' });
    expect((await view(t.a)).round).toEqual({ roundNo: 1, previousGameId: null, latestGameId: newId });
    expect(learning()).toEqual(learningBefore);
    await expectError(rematch(t.a), 409, 'not_latest_round');
    await expectError(rematch(t.b, false), 409, 'not_latest_round');
  });

  it('C7: the room code after the new round joins the new round; an old member with their PIN gets their own new member', async () => {
    const t = await endedTable();
    for (const seat of t.seats) await expectOk(rematch(seat));
    const newId = nextRounds(t.gameId)[0]!.id as string;

    const fresh = await call('POST', '/api/join', { body: { inviteCode: t.inviteCode, name: 'ดี', pin: '2222' } });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(JoinResponse.parse(fresh.body)).toMatchObject({ created: true, member: { gameId: newId, name: 'ดี' } });

    const back = await call('POST', '/api/join', { body: { inviteCode: t.inviteCode, name: 'บี', pin: '1111' } });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const joined = JoinResponse.parse(back.body);
    expect(joined).toMatchObject({ created: false, member: { gameId: newId, name: 'บี' } });
    expect(joined.member.id).not.toBe(t.b.memberId);
    expect(joined.member.id).toBe((await newSeat(t.b)).memberId);
    await expectError(call('POST', '/api/join', { body: { inviteCode: t.inviteCode, name: 'บี', pin: '9999' } }), 401, 'wrong_pin');
  });

  it('C8: a member kicked in the old round has no member in the new one, and joining with that name is still 403 kicked', async () => {
    const t = await endedTable();
    blockMember(server!.orm, t.c.memberId, CLOCK);
    await expectOk(rematch(t.a));
    await expectOk(rematch(t.b));
    const newId = nextRounds(t.gameId)[0]!.id as string;
    expect(namesIn(newId)).toEqual(['นก', 'บี']);

    await expectError(call('POST', '/api/join', { body: { inviteCode: t.inviteCode, name: 'ซี', pin: '1111' } }), 403, 'kicked');
    expect(namesIn(newId)).toEqual(['นก', 'บี']);
  });

  it('C9: a game the server owner closed can have its new round like a normal end', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameOf(t.a.memberId);
    expect(closeGame(server!.orm, gameId, { confirmName: 'เมืองก่อนอุกกาบาต' }, CLOCK).kind).toBe('closed');
    for (const seat of [t.a, t.b, t.c]) await expectOk(rematch(seat));
    expect(nextRounds(gameId)).toHaveLength(1);
    const seat = await newSeat(t.a);
    expect(gameOf(seat.memberId)).toBe(nextRounds(gameId)[0]!.id);
  });

  it('C10: the AI GM not ready: 503 with the same reason, no new round, the readies stay; once ready a ready true makes it', async () => {
    const t = await endedTable();
    await expectOk(rematch(t.a));
    await expectOk(rematch(t.b));
    await reboot({ ai: AI_WITHOUT_KEY });
    const blocked = await expectError(rematch(t.c), 503, 'ai_not_ready');
    const createBlocked = ApiError.parse((await call('POST', '/api/games', { body: { createCode: 'x', gameName: 'x', mode: 'single', humanGm: false, name: 'x', pin: '1234' } })).body);
    expect(blocked.message).toBe(createBlocked.message);
    expect(nextRounds(t.gameId)).toEqual([]);
    expect(await rematchReadyOf(t.a)).toEqual({ [t.a.memberId]: true, [t.b.memberId]: true, [t.c.memberId]: true });

    await reboot();
    await expectOk(rematch(t.c));
    expect(nextRounds(t.gameId)).toHaveLength(1);
  });

  it('C11: the new round has the old settings, scenario, memory and Human GM, and no character, loot or Karma from the old round', async () => {
    const CODE = 'nok-isk023';
    const source = await startedTable(server!, false, { playerCode: CODE, gameName: 'เกมเก่า' });
    const sourceId = gameOf(source.a.memberId);
    end(sourceId);
    const scenario = { ...defaultScenario(), name: 'เมืองของ ISK-023' };
    const t = await endedTable(true, { tone: 'C', npcDialogue: 'high', playerCode: CODE, memory: { enabled: true, sourceGameIds: [sourceId] }, scenario });
    // The Human GM is not a player: no rematch ready for them.
    await expectError(rematch(t.gm!), 409, 'not_allowed');
    for (const seat of t.seats) await expectOk(rematch(seat));
    const next = nextRounds(t.gameId)[0]!;
    const old = server!.db.prepare('select * from game where id = ?').get(t.gameId) as Record<string, unknown>;
    for (const column of ['name', 'mode', 'human_gm', 'auto_approve_lines', 'npc_dialogue', 'tone', 'learning_sources']) expect(next[column], column).toEqual(old[column]);
    expect(next).toMatchObject({ tone: 'C', npc_dialogue: 'high', human_gm: 1, started_at: null, invite_code: t.inviteCode });
    expect(getGameScenario(server!.orm, next.id as string)).toEqual(sortTimeline(scenario));

    const gm = await newSeat(t.gm!);
    // The creator's player code link (learning of the style) goes along with their new member.
    const keyOf = (memberId: string) => (server!.db.prepare('select player_key as k from member_style where member_id = ?').get(memberId) as { k: string } | undefined)?.k;
    expect(keyOf(gm.memberId)).toBe(keyOf(t.gm!.memberId));
    expect(keyOf(gm.memberId)).toBeTypeOf('string');
    const fresh = await view(gm);
    expect(fresh).toMatchObject({ humanGm: true, you: { role: 'gm' }, memory: { enabled: true, sources: [{ id: sourceId, name: 'เกมเก่า' }] } });
    const ids = (server!.db.prepare('select id from member where game_id = ?').all(next.id) as { id: string }[]).map((r) => r.id);
    expect(ids).toHaveLength(4);
    for (const table of ['character', 'character_loot', 'character_origin']) {
      expect((server!.db.prepare(`select count(*) as n from ${table} where member_id in (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }).n, table).toBe(0);
    }
    // Karma lives on the character: the new members start the character step with none.
    const res = await call('GET', '/api/game/character', { token: (await newSeat(t.a)).token });
    expect(res.body).toEqual({ character: null });
  });

  it('C12: an old database migrates: every game is round 1 with no previous round and goes on as before', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameOf(t.a.memberId);
    await server!.close();
    server = undefined;
    const Database = (await import('better-sqlite3')).default;
    const sqlite = new Database(`${dir}/isekai.sqlite`);
    // Back to the schema before ISK-023, its migration not applied yet.
    sqlite.prepare('drop index game_previous_game_id').run();
    sqlite.prepare('alter table game drop column previous_game_id').run();
    sqlite.prepare('alter table game drop column round_no').run();
    sqlite.prepare('alter table member drop column rematch_ready_at').run();
    const when = journal.entries.find((e) => e.tag.endsWith('_rematch'))!.when;
    expect(sqlite.prepare('delete from __drizzle_migrations where created_at >= ?').run(when).changes).toBe(1);
    sqlite.close();

    await boot();
    expect(server!.db.prepare('select round_no as n, previous_game_id as p from game where id = ?').get(gameId)).toEqual({ n: 1, p: null });
    const after = await view(t.b);
    expect(after).toMatchObject({ id: gameId, status: 'started', round: { roundNo: 1, previousGameId: null, latestGameId: null } });
    expect(after.members.every((m) => m.rematchReady === false)).toBe(true);
    const room = await roomSocket(t.a);
    expect(room.messages.some((m) => m.type === 'room')).toBe(true);
    end(gameId);
    for (const seat of [t.a, t.b, t.c]) await expectOk(rematch(seat));
    expect(nextRounds(gameId)).toHaveLength(1);

    // Additive only: new columns + an index, no data touched.
    const sql = readFileSync(join(migrationsFolder, `${journal.entries.find((e) => e.tag.endsWith('_rematch'))!.tag}.sql`), 'utf8');
    expect(sql).toMatch(/ADD `previous_game_id`/);
    expect(sql).not.toMatch(/\bdrop\b|\bdelete\b|\bupdate\b|\binsert\b/i);
  });

  it('C13: GET /api/game after a reload at 2/3 shows each rematchReady; after the new round the old round names it in latestGameId', async () => {
    const t = await endedTable();
    await expectOk(rematch(t.a));
    await expectOk(rematch(t.c));
    await reboot();
    expect(await rematchReadyOf(t.b)).toEqual({ [t.a.memberId]: true, [t.b.memberId]: false, [t.c.memberId]: true });
    expect((await view(t.b)).round).toEqual({ roundNo: 1, previousGameId: null, latestGameId: null });

    await expectOk(rematch(t.b));
    const newId = nextRounds(t.gameId)[0]!.id as string;
    expect((await view(t.b)).round).toEqual({ roundNo: 1, previousGameId: null, latestGameId: newId });
    expect((await view(await newSeat(t.b))).round).toEqual({ roundNo: 2, previousGameId: t.gameId, latestGameId: null });
  });

  it('C14: offline at rematch_started, rematch/session later gives the latest round\'s token, again and again, no extra member; the new token opens the previous round\'s history', async () => {
    const t = await endedTable();
    for (const seat of t.seats) await expectOk(rematch(seat));
    const newId = nextRounds(t.gameId)[0]!.id as string;
    const count = () => (server!.db.prepare('select count(*) as n from member where game_id = ?').get(newId) as { n: number }).n;

    const first = await newSeat(t.c);
    const second = await newSeat(t.c);
    expect(second.memberId).toBe(first.memberId);
    expect(second.token).not.toBe(first.token);
    // The new round's own token: still the latest round's member.
    expect((await newSeat(first)).memberId).toBe(first.memberId);
    expect(count()).toBe(3);

    const own = await call('GET', '/api/game/log', { token: t.c.token });
    const viaNew = await call('GET', `/api/game/log?gameId=${t.gameId}`, { token: first.token });
    expect(viaNew.status, JSON.stringify(viaNew.body)).toBe(200);
    expect(GameLogResponse.parse(viaNew.body).game.id).toBe(t.gameId);
    expect(viaNew.body).toEqual(own.body);
    // Another room's game is not theirs.
    const other = await startedTable(server!, false, { gameName: 'ห้องอื่น' });
    await expectError(call('GET', `/api/game/log?gameId=${gameOf(other.a.memberId)}`, { token: first.token }), 404, 'game_not_found');
  });
});
