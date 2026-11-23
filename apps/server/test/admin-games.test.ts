import { AdminGameRow, AdminGamesResponse, ApiError, CreateGameResponse, GameLogResponse, GameView, JoinResponse, MemorySourcesResponse, type RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { extractDue } from '../src/learning/extract.ts';
import type { PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, recordAction, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, isRoom, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call } from './visibility-fixture.ts';

/**
 * ISK-001: the server owner lists every game (GET /api/admin/games) and closes one that has not ended
 * (POST /api/admin/games/:id/close {confirmName, reason?}). A played game ends "closed" with the normal end page
 * (reveal, rating, votes, learning) and no AI ending; a lobby / setup game ends with no end page.
 */
const ADMIN_CODE = 'ทดสอบ-ปิดเกม-isk001';
const PLAYER_CODE = 'isk-001-code';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ISK-001 admin game list + close', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
  let sockets: RoomClient[] = [];
  /** Set by a test to hold the turn / the ending until it resolves; `called` resolves when the room asked. */
  let turnGate: { promise: Promise<void>; called: ReturnType<typeof deferred> } | null = null;
  let finaleGate: { promise: Promise<void>; called: ReturnType<typeof deferred> } | null = null;

  const resolver: PhaseResolver = {
    async resolve() {
      if (turnGate) {
        turnGate.called.resolve();
        await turnGate.promise;
      }
      return { entries: [{ kind: 'feed', locationId: null, actorMemberId: null, text: 'ผลของเทิร์น' }] };
    },
    async finale() {
      if (finaleGate) {
        finaleGate.called.resolve();
        await finaleGate.promise;
      }
      return { entries: [{ kind: 'feed', locationId: null, actorMemberId: null, text: 'ฉากจบ' }] };
    },
  };

  async function boot() {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null, phaseResolver: resolver },
    );
    call = caller(server);
  }

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    turnGate = null;
    finaleGate = null;
    await boot();
  });
  afterEach(async () => {
    for (const s of sockets) await s.close();
    sockets = [];
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function admin(): Promise<string> {
    const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(res.status).toBe(200);
    return (res.body as { token: string }).token;
  }
  const list = async (token: string) => {
    const res = await call('GET', '/api/admin/games', { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AdminGamesResponse.parse(res.body).games;
  };
  const close = (token: string, gameId: string, body: unknown) => call('POST', `/api/admin/games/${gameId}/close`, { token, body });
  const rowOf = async (token: string, gameId: string) => (await list(token)).find((g) => g.id === gameId)!;

  const gameIdOf = (seat: { memberId: string }) => (server!.db.prepare('select game_id as id from member where id = ?').get(seat.memberId) as { id: string }).id;
  const closeRows = (gameId: string) => (server!.db.prepare('select count(*) as n from game_close where game_id = ?').get(gameId) as { n: number }).n;
  const entryCount = (gameId: string) => (server!.db.prepare('select count(*) as n from room_entry where game_id = ?').get(gameId) as { n: number }).n;
  const usageCount = () => (server!.db.prepare('select count(*) as n from ai_usage').get() as { n: number }).n;
  const phaseRow = (gameId: string) => server!.db.prepare('select state, updated_at as at from game_phase where game_id = ?').get(gameId) as { state: string; at: number } | undefined;

  /** A lobby game: นก (owner, player) and บี joined. */
  async function lobbyGame(name = 'ห้องรอ', extra: Record<string, unknown> = {}) {
    const created = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: name, mode: 'online', humanGm: false, name: 'นก', pin: '1234', ...extra } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const game = CreateGameResponse.parse(created.body);
    const joined = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name: 'บี', pin: '1111' } });
    expect(joined.status).toBe(200);
    const b = JoinResponse.parse(joined.body);
    return { gameId: game.game.id, owner: { token: game.token, memberId: game.member.id }, b: { token: b.token, memberId: b.member.id } };
  }

  /** Started, every player has a character, nobody entered the play room yet. */
  async function setupGame(name = 'ตั้งตัวละคร', extra: Record<string, unknown> = {}) {
    const t = await startedTable(server!, false, { gameName: name, ...extra });
    const gameId = gameIdOf(t.a);
    expect(phaseRow(gameId)).toBeUndefined();
    return { t, gameId };
  }

  /** In play at `day` / `period` turn 1, actions open. */
  async function playingGame(name = 'กำลังเล่น', at: { day: number; phase: 'EOSORIA' | 'NOCTHERION'; turn: 1 | 2 } = { day: 4, phase: 'EOSORIA', turn: 1 }, time = CLOCK, extra: Record<string, unknown> = {}) {
    const t = await startedTable(server!, false, { gameName: name, ...extra });
    const gameId = gameIdOf(t.a);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), ...at, status: 'collecting', submissions: {} }, time);
    return { t, gameId };
  }

  /** Ended by the finale (day 12 NOCTHERION turn 2). */
  async function finaleGame(name = 'จบแล้ว', time = CLOCK, status: 'finale' | 'game_over' = 'finale') {
    const t = await startedTable(server!, false, { gameName: name });
    const gameId = gameIdOf(t.a);
    recordAction(server!.orm, gameId, { day: 1, phase: 'EOSORIA', turn: 1 }, t.b.memberId, { text: 'แอบหยิบถุงเงิน', visibility: 'secret', rest: false }, CLOCK);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status }, time);
    return { t, gameId };
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const c = await openRoom(server!, { token: seat.token });
    sockets.push(c);
    return c;
  }
  const isClosedEvent = (m: RoomServerMessage) => m.type === 'game_closed';
  const logOf = (t: { call: Call }, seat: { token: string }) => t.call('GET', '/api/game/log', { token: seat.token });

  it('C1: no admin session → 401 on list and close, nothing closed; an unknown id → 404 game_not_found', async () => {
    const { t, gameId } = await playingGame();
    for (const token of [undefined, t.a.token, 'not-a-token']) {
      const listed = await call('GET', '/api/admin/games', token ? { token } : {});
      expect(listed.status).toBe(401);
      expect(ApiError.parse(listed.body).code).toBe('unauthorized');
      const closed = await call('POST', `/api/admin/games/${gameId}/close`, { ...(token ? { token } : {}), body: { confirmName: 'กำลังเล่น' } });
      expect(closed.status).toBe(401);
    }
    expect(closeRows(gameId)).toBe(0);
    expect((await rowOf(await admin(), gameId)).phase).toBe('playing');

    const missing = await close(await admin(), 'no-such-game', { confirmName: 'x' });
    expect(missing.status).toBe(404);
    expect(ApiError.parse(missing.body).code).toBe('game_not_found');
  });

  it('C2: lobby, setup, playing day 4 EOSORIA and an ended finale: 4 rows with the right phase, newest action first', async () => {
    const lobby = await lobbyGame();
    const setup = await setupGame();
    const playing = await playingGame('กำลังเล่น', { day: 4, phase: 'EOSORIA', turn: 1 }, CLOCK + 3_000);
    const ended = await finaleGame('จบแล้ว', CLOCK + 2_000);

    const games = await list(await admin());
    expect(games).toHaveLength(4);
    expect(games.slice(0, 2).map((g) => g.id)).toEqual([playing.gameId, ended.gameId]);
    expect(new Set(games.slice(2).map((g) => g.id))).toEqual(new Set([lobby.gameId, setup.gameId]));
    const byId = new Map(games.map((g) => [g.id, g]));
    expect(byId.get(lobby.gameId)).toMatchObject({ name: 'ห้องรอ', phase: 'lobby', endedReason: null, day: null, period: null, playerCount: 2, lastActionAt: null });
    expect(byId.get(setup.gameId)).toMatchObject({ phase: 'setup', endedReason: null, day: null, period: null, playerCount: 3, lastActionAt: null });
    expect(byId.get(playing.gameId)).toMatchObject({ phase: 'playing', endedReason: null, day: 4, period: 'EOSORIA', playerCount: 3, lastActionAt: new Date(CLOCK + 3_000).toISOString() });
    expect(byId.get(ended.gameId)).toMatchObject({ phase: 'ended', endedReason: 'finale', day: 12, period: 'NOCTHERION' });
    for (const g of games) expect(g.aiUsd).toBeGreaterThanOrEqual(0);
  });

  it('C3: confirmName is trimmed (and NFC) before the exact match; a near miss is 400 confirm_required and the game plays on', async () => {
    const token = await admin();
    const one = await playingGame('ทดสอบ');
    const res = await close(token, one.gameId, { confirmName: ' ทดสอบ ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(AdminGameRow.parse(res.body)).toMatchObject({ id: one.gameId, phase: 'ended', endedReason: 'closed' });

    const cafe = await playingGame('Café');
    expect((await close(token, cafe.gameId, { confirmName: 'Café' })).status).toBe(200);

    const two = await playingGame('ทดสอบ');
    for (const confirmName of ['ทดสอ', 'ทดสอบบ', '']) {
      const refused = await close(token, two.gameId, { confirmName });
      expect(refused.status).toBe(400);
      expect(ApiError.parse(refused.body).code).toBe('confirm_required');
    }
    expect(closeRows(two.gameId)).toBe(0);
    expect((await rowOf(token, two.gameId)).phase).toBe('playing');
    const a = await enter(two.t.a);
    await a.waitFor(isReady);
    a.action('สำรวจตลาด', 'public');
    expect(await a.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected' || m.type === 'error')).toEqual({ type: 'action_accepted' });
  });

  it('C4: a reason of 200 code points closes; 201 is 400 reason_too_long (nothing closed); blank = no reason', async () => {
    const token = await admin();
    const ok = await playingGame('ยาวพอดี');
    expect((await close(token, ok.gameId, { confirmName: 'ยาวพอดี', reason: ` ${'ก'.repeat(199)}😀 ` })).status).toBe(200);
    expect(GameLogResponse.parse((await logOf(ok.t, ok.t.a)).body).game.closeReason).toBe(`${'ก'.repeat(199)}😀`);

    const long = await playingGame('ยาวเกิน');
    const refused = await close(token, long.gameId, { confirmName: 'ยาวเกิน', reason: 'ก'.repeat(201) });
    expect(refused.status).toBe(400);
    expect(ApiError.parse(refused.body).code).toBe('reason_too_long');
    expect(closeRows(long.gameId)).toBe(0);

    const blank = await playingGame('ไม่มีเหตุผล');
    expect((await close(token, blank.gameId, { confirmName: 'ไม่มีเหตุผล', reason: '   ' })).status).toBe(200);
    expect(GameLogResponse.parse((await logOf(blank.t, blank.t.a)).body).game.closeReason).toBeNull();
  });

  it('C5: both connected players get game_closed {reason, hasSummary:true}; the end page is the normal one with closedEarly + closeReason, rating and ruling votes work', async () => {
    const { t, gameId } = await playingGame();
    recordAction(server!.orm, gameId, { day: 1, phase: 'EOSORIA', turn: 1 }, t.b.memberId, { text: 'แอบหยิบถุงเงิน', visibility: 'secret', rest: false }, CLOCK);
    const a = await enter(t.a);
    const b = await enter(t.b);
    await a.waitFor(isReady);
    await b.waitFor(isReady);

    expect((await close(await admin(), gameId, { confirmName: 'กำลังเล่น', reason: 'ทดสอบระบบ' })).status).toBe(200);
    for (const c of [a, b]) expect(await c.waitFor(isClosedEvent)).toEqual({ type: 'game_closed', reason: 'ทดสอบระบบ', hasSummary: true });

    const log = GameLogResponse.parse((await logOf(t, t.a)).body);
    expect(log.game).toMatchObject({ status: 'ended', endReason: 'closed', closedEarly: true, closeReason: 'ทดสอบระบบ' });
    expect(log.reveal!.players.map((p) => p.memberId)).toEqual([t.a.memberId, t.b.memberId, t.c.memberId]);
    const secret = log.reveal!.players.find((p) => p.memberId === t.b.memberId)!.secretActions[0]!;
    expect(secret.text).toBe('แอบหยิบถุงเงิน');

    expect((await t.call('PUT', '/api/game/rating', { token: t.a.token, body: { score: 7 } })).status).toBe(200);
    const vote = await t.call('PUT', `/api/game/rating/votes/${encodeURIComponent(secret.sourceRef!)}`, { token: t.a.token, body: { vote: 'up' } });
    expect(vote.status, JSON.stringify(vote.body)).toBe(200);
  });

  it('C6: closing a played game makes no AI call (no new ai_usage row)', async () => {
    const { gameId } = await playingGame();
    await pause(100);
    const before = usageCount();
    const token = await admin();
    expect((await close(token, gameId, { confirmName: 'กำลังเล่น' })).status).toBe(200);
    await pause(300);
    expect(usageCount()).toBe(before);
    expect((await rowOf(token, gameId)).endedReason).toBe('closed');
  });

  it('C7: a lobby / setup game closes with game_closed {hasSummary:false}; no end page (404 not_started), no extract, not a memory source', async () => {
    const token = await admin();
    const lobby = await lobbyGame('ห้องรอ', { playerCode: PLAYER_CODE });
    const setup = await setupGame('ตั้งตัวละคร', { playerCode: PLAYER_CODE });
    expect((await close(token, lobby.gameId, { confirmName: 'ห้องรอ' })).status).toBe(200);
    expect((await close(token, setup.gameId, { confirmName: 'ตั้งตัวละคร' })).status).toBe(200);
    expect((await rowOf(token, lobby.gameId)).endedReason).toBe('closed');

    // Lobby and setup have no play-room socket: who comes to the room gets the close, then the socket ends.
    for (const seat of [lobby.owner, lobby.b, setup.t.a]) {
      const c = await enter(seat);
      expect(await c.waitFor(isClosedEvent)).toEqual({ type: 'game_closed', reason: null, hasSummary: false });
      await c.closed;
    }
    // The lobby polls GET /api/game.
    expect(GameView.parse((await call('GET', '/api/game', { token: lobby.b.token })).body).closed).toEqual({ reason: null, hasSummary: false });

    for (const seat of [lobby.owner, setup.t.a]) {
      const log = await call('GET', '/api/game/log', { token: seat.token });
      expect(log.status).toBe(404);
      expect(ApiError.parse(log.body).code).toBe('not_started');
    }
    expect(extractDue(server!.orm, CLOCK + 400 * 86_400_000, 1)).not.toContain(lobby.gameId);
    expect(extractDue(server!.orm, CLOCK + 400 * 86_400_000, 1)).not.toContain(setup.gameId);
    expect((await call('POST', `/api/admin/learning/games/${setup.gameId}/extract`, { token })).status).toBe(409);
    const sources = await call('POST', '/api/memory/sources', { body: { playerCode: PLAYER_CODE } });
    expect(sources.status, JSON.stringify(sources.body)).toBe(200);
    const ids = MemorySourcesResponse.parse(sources.body).games.map((g) => g.id);
    expect(ids).not.toContain(lobby.gameId);
    expect(ids).not.toContain(setup.gameId);
  });

  it('C8: after the close every socket command and changing HTTP call is 409 game_closed and the state does not change', async () => {
    const { t, gameId } = await playingGame();
    const lobby = await lobbyGame();
    const token = await admin();
    expect((await close(token, gameId, { confirmName: 'กำลังเล่น' })).status).toBe(200);
    expect((await close(token, lobby.gameId, { confirmName: 'ห้องรอ' })).status).toBe(200);
    const state = phaseRow(gameId)!.state;
    const entries = entryCount(gameId);

    const a = await enter(t.a);
    await a.waitFor(isReady);
    const commands: unknown[] = [
      { type: 'action', text: 'สำรวจตลาด', visibility: 'public' },
      { type: 'whisper', to: 'p-1', text: 'ลับนะ' },
      { type: 'move', to: 'ตลาด' },
      { type: 'omen', to: 'p-1', text: 'ระวัง' },
      { type: 'retry' },
    ];
    for (const command of commands) {
      const from = a.messages.length;
      a.send(command);
      expect(await a.waitFor((m) => m.type === 'error', from)).toMatchObject({ type: 'error', code: 'game_closed' });
    }

    const http: [string, string, { token: string }, unknown][] = [
      ['POST', '/api/game/npc-chat', t.a, { npc: 'n-1', text: 'สวัสดี' }],
      ['POST', '/api/game/companions', t.a, { ref: 'n-1' }],
      ['PUT', '/api/game/character', t.a, { name: 'ลิน', appearance: 'ใหม่', personality: 'ใหม่' }],
      ['PATCH', '/api/game', t.a, { npcDialogue: 'high' }],
      ['POST', '/api/game/start', lobby.owner, undefined],
      ['PATCH', '/api/game', lobby.owner, { gameName: 'ชื่อใหม่' }],
      ['POST', '/api/game/character', lobby.b, { name: 'บี', appearance: 'สูง', personality: 'เงียบ' }],
    ];
    for (const [method, path, seat, body] of http) {
      const res = await call(method, path, { token: seat.token, ...(body === undefined ? {} : { body }) });
      expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(409);
      expect(ApiError.parse(res.body).code).toBe('game_closed');
    }
    expect(phaseRow(gameId)!.state).toBe(state);
    expect(entryCount(gameId)).toBe(entries);
  });

  it('C9: a turn waiting for the AI is closed before it answers: no new room entry, the game stays closed', async () => {
    const { t, gameId } = await playingGame();
    const release = deferred();
    turnGate = { promise: release.promise, called: deferred() };
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const c of clients) await c.waitFor(isReady);
    for (const [i, c] of clients.entries()) c.action(`ทำสิ่งที่ ${i}`, 'public');
    await turnGate.called.promise;

    const token = await admin();
    expect((await close(token, gameId, { confirmName: 'กำลังเล่น' })).status).toBe(200);
    const entries = entryCount(gameId);
    release.resolve();
    await pause(300);
    expect(entryCount(gameId)).toBe(entries);
    expect(await rowOf(token, gameId)).toMatchObject({ phase: 'ended', endedReason: 'closed', day: 4, period: 'EOSORIA' });
  });

  it('C9: the ending being written when the game is closed: its late result is dropped, the game is closed', async () => {
    const { t, gameId } = await playingGame('ฉากจบ', { day: 12, phase: 'NOCTHERION', turn: 2 });
    const release = deferred();
    finaleGate = { promise: release.promise, called: deferred() };
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const c of clients) await c.waitFor(isReady);
    for (const [i, c] of clients.entries()) c.action(`ทำสิ่งที่ ${i}`, 'public');
    await finaleGate.called.promise;

    const token = await admin();
    const res = await close(token, gameId, { confirmName: 'ฉากจบ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const entries = entryCount(gameId);
    release.resolve();
    await pause(300);
    expect(entryCount(gameId)).toBe(entries);
    expect((await rowOf(token, gameId)).endedReason).toBe('closed');
    expect(GameLogResponse.parse((await logOf(t, t.a)).body).game).toMatchObject({ endReason: 'closed', closedEarly: true });
  });

  it('C10: a player offline at the close who enters again gets the ended room and game_closed, never a playable game', async () => {
    const { t, gameId } = await playingGame();
    expect((await close(await admin(), gameId, { confirmName: 'กำลังเล่น', reason: 'ปิดปรับปรุง' })).status).toBe(200);
    const a = await enter(t.a);
    await a.waitFor(isReady);
    expect(await a.waitFor(isClosedEvent)).toEqual({ type: 'game_closed', reason: 'ปิดปรับปรุง', hasSummary: true });
    const room = a.messages.filter(isRoom).at(-1)!;
    expect(room.status).toBe('finale');
    expect(room.you.lock?.code).toBe('game_ended');
    expect(GameView.parse((await call('GET', '/api/game', { token: t.b.token })).body).closed).toEqual({ reason: 'ปิดปรับปรุง', hasSummary: true });
  });

  it('C11: after a restart the close, closedEarly and its reason are still there; the history says closed', async () => {
    const { t, gameId } = await playingGame();
    expect((await close(await admin(), gameId, { confirmName: 'กำลังเล่น', reason: 'ทดสอบ restart' })).status).toBe(200);
    await server!.close();
    await boot();
    const log = GameLogResponse.parse((await call('GET', '/api/game/log', { token: t.a.token })).body);
    expect(log.game).toMatchObject({ status: 'ended', endReason: 'closed', closedEarly: true, closeReason: 'ทดสอบ restart' });
    expect(await rowOf(await admin(), gameId)).toMatchObject({ phase: 'ended', endedReason: 'closed' });
  });

  it('C12: a closed played game everyone rated is extracted like a finale and can be picked as a memory (GEN-083)', async () => {
    const { t, gameId } = await playingGame('ปิดแล้วเรียนรู้', { day: 4, phase: 'EOSORIA', turn: 1 }, CLOCK, { playerCode: PLAYER_CODE });
    expect((await close(await admin(), gameId, { confirmName: 'ปิดแล้วเรียนรู้' })).status).toBe(200);
    for (const seat of [t.a, t.b, t.c]) expect((await t.call('PUT', '/api/game/rating', { token: seat.token, body: { score: 8 } })).status).toBe(200);
    await expect.poll(() => server!.db.prepare('select status from learning_extract where game_id = ?').get(gameId), { timeout: 5_000 }).toEqual({ status: 'done' });
    const sources = await call('POST', '/api/memory/sources', { body: { playerCode: PLAYER_CODE } });
    expect(MemorySourcesResponse.parse(sources.body).games.map((g) => g.id)).toContain(gameId);
  });

  it('C13: one audit row per close; a second close or an ended game is 409 already_ended with no row; two at once close once', async () => {
    const token = await admin();
    const { gameId } = await playingGame();
    expect((await close(token, gameId, { confirmName: 'กำลังเล่น', reason: 'เหตุผล' })).status).toBe(200);
    expect(server!.db.prepare('select game_id as gameId, game_name as name, reason, closed_at as at from game_close').all()).toEqual([{ gameId, name: 'กำลังเล่น', reason: 'เหตุผล', at: CLOCK }]);
    const again = await close(token, gameId, { confirmName: 'กำลังเล่น' });
    expect(again.status).toBe(409);
    expect(ApiError.parse(again.body).code).toBe('already_ended');
    expect(closeRows(gameId)).toBe(1);

    const ended = await finaleGame();
    const refused = await close(token, ended.gameId, { confirmName: 'จบแล้ว' });
    expect(refused.status).toBe(409);
    expect(ApiError.parse(refused.body).code).toBe('already_ended');
    expect(closeRows(ended.gameId)).toBe(0);

    const race = await playingGame('แข่งกัน');
    const both = await Promise.all([close(token, race.gameId, { confirmName: 'แข่งกัน' }), close(token, race.gameId, { confirmName: 'แข่งกัน' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(closeRows(race.gameId)).toBe(1);
  });

  it('C14: game_closed and the closed end page carry no karma / DC / unrevealed secret; finale and game_over games are unchanged (closedEarly false)', async () => {
    const { t, gameId } = await playingGame();
    const a = await enter(t.a);
    await a.waitFor(isReady);
    expect((await close(await admin(), gameId, { confirmName: 'กำลังเล่น', reason: 'ทดสอบ' })).status).toBe(200);
    await a.waitFor(isClosedEvent);
    const frame = JSON.parse(a.raw.find((r) => r.includes('"game_closed"'))!) as Record<string, unknown>;
    expect(Object.keys(frame).sort()).toEqual(['hasSummary', 'reason', 'type']);
    expect(forbiddenKeysIn(frame)).toEqual([]);

    const closedLog = GameLogResponse.parse((await logOf(t, t.a)).body);
    const finale = await finaleGame('จบปกติ');
    const finaleLog = GameLogResponse.parse((await logOf(finale.t, finale.t.a)).body);
    // The closed end page has exactly the fields of a normal one; outside the reveal nothing GM-only, nowhere a DC.
    expect(Object.keys(closedLog.game).sort()).toEqual(Object.keys(finaleLog.game).sort());
    expect(forbiddenKeysIn({ ...closedLog, reveal: null })).toEqual([]);
    expect(JSON.stringify(closedLog)).not.toMatch(/"dc/i);

    expect(finaleLog.game).toMatchObject({ status: 'ended', endReason: 'finale', closedEarly: false, closeReason: null });
    const over = await finaleGame('ทุกคนล้ม', CLOCK, 'game_over');
    expect(GameLogResponse.parse((await logOf(over.t, over.t.a)).body).game).toMatchObject({ endReason: 'game_over', closedEarly: false, closeReason: null });
    expect((await finale.t.call('PUT', '/api/game/rating', { token: finale.t.a.token, body: { score: 9 } })).status).toBe(200);
  });
});
