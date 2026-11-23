import { AdminInviteCodeResponse, AdminMembersResponse, ApiError, CreateGameResponse, GameView, JoinResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import type { PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, recordAction, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call } from './visibility-fixture.ts';

/**
 * ISK-018: the server owner kicks a member (POST /api/admin/games/:id/members/:memberId/kick), lists a game's
 * members (GET /api/admin/games/:id/members) and renews its invite code (POST /api/admin/games/:id/invite-code).
 * Each change leaves one `admin_game_audit` row; the invite code is never stored there nor logged.
 */
const ADMIN_CODE = 'ทดสอบ-เตะ-isk018';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ISK-018 admin kick + members + invite code', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;
  let sockets: RoomClient[] = [];
  let logLines: string[] = [];
  let resolveCalls = 0;
  let turnGate: { promise: Promise<void>; called: ReturnType<typeof deferred> } | null = null;

  const resolver: PhaseResolver = {
    async resolve() {
      resolveCalls++;
      if (turnGate) {
        turnGate.called.resolve();
        await turnGate.promise;
      }
      return { entries: [{ kind: 'feed', locationId: null, actorMemberId: null, text: 'ผลของเทิร์น' }] };
    },
    async finale() {
      return { entries: [{ kind: 'feed', locationId: null, actorMemberId: null, text: 'ฉากจบ' }] };
    },
  };

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    logLines = [];
    resolveCalls = 0;
    turnGate = null;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: (line) => logLines.push(line), rng: null, phaseResolver: resolver },
    );
    call = caller(server);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
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
  const membersOf = (token: string | undefined, gameId: string) => call('GET', `/api/admin/games/${gameId}/members`, token ? { token } : {});
  const kick = (token: string | undefined, gameId: string, memberId: string) => call('POST', `/api/admin/games/${gameId}/members/${memberId}/kick`, token ? { token } : {});
  const renew = (token: string | undefined, gameId: string) => call('POST', `/api/admin/games/${gameId}/invite-code`, token ? { token } : {});

  const gameIdOf = (seat: { memberId: string }) => (server!.db.prepare('select game_id as id from member where id = ?').get(seat.memberId) as { id: string }).id;
  const kickedAtOf = (memberId: string) => (server!.db.prepare('select kicked_at as at from member where id = ?').get(memberId) as { at: number | null }).at;
  const inviteOf = (gameId: string) => (server!.db.prepare('select invite_code as code from game where id = ?').get(gameId) as { code: string }).code;
  const auditRows = () => server!.db.prepare('select * from admin_game_audit order by id').all() as Record<string, unknown>[];

  /** A lobby game: นก (owner, player) and บี joined. */
  async function lobbyGame(name = 'ห้องรอ') {
    const created = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: name, mode: 'online', humanGm: false, name: 'นก', pin: '1234' } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const game = CreateGameResponse.parse(created.body);
    const joined = await call('POST', '/api/join', { body: { inviteCode: game.game.inviteCode, name: 'บี', pin: '1111' } });
    expect(joined.status).toBe(200);
    const b = JoinResponse.parse(joined.body);
    return { gameId: game.game.id, inviteCode: game.game.inviteCode, owner: { token: game.token, memberId: game.member.id }, b: { token: b.token, memberId: b.member.id } };
  }

  /** In play at day 4 EOSORIA turn 1, actions open. */
  async function playingGame(humanGm = false) {
    const t = await startedTable(server!, humanGm);
    const gameId = gameIdOf(t.a);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 4, phase: 'EOSORIA', turn: 1, status: 'collecting', submissions: {} }, CLOCK);
    return { t, gameId };
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const c = await openRoom(server!, { token: seat.token });
    sockets.push(c);
    await c.waitFor(isReady);
    return c;
  }
  const accepted = (c: RoomClient, from: number) => c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);

  it('C1: no admin session → 401 on members, kick and invite-code; nothing changes', async () => {
    const g = await lobbyGame();
    for (const token of [undefined, g.owner.token, 'not-a-token']) {
      for (const res of [await membersOf(token, g.gameId), await kick(token, g.gameId, g.b.memberId), await renew(token, g.gameId)]) {
        expect(res.status).toBe(401);
        expect(ApiError.parse(res.body).code).toBe('unauthorized');
      }
    }
    expect(kickedAtOf(g.b.memberId)).toBeNull();
    expect(inviteOf(g.gameId)).toBe(g.inviteCode);
    expect((await call('GET', '/api/game', { token: g.b.token })).status).toBe(200);
    expect(auditRows()).toEqual([]);
  });

  it('C2: kicked in the lobby → the session stops working and the name cannot join again (403 kicked)', async () => {
    const g = await lobbyGame();
    const res = await kick(await admin(), g.gameId, g.b.memberId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(AdminMembersResponse.parse(res.body).members.find((m) => m.id === g.b.memberId)!.kickedAt).toBe(new Date(CLOCK).toISOString());

    expect((await call('GET', '/api/game', { token: g.b.token })).status).toBe(401);
    const again = await call('POST', '/api/join', { body: { inviteCode: g.inviteCode, name: 'บี', pin: '1111' } });
    expect(again.status).toBe(403);
    expect(ApiError.parse(again.body).code).toBe('kicked');
    // The owner stays, and the lobby no longer lists บี.
    const view = GameView.parse((await call('GET', '/api/game', { token: g.owner.token })).body);
    expect(view.members.map((m) => m.name)).toEqual(['นก']);
  });

  it('C3: a turn waiting only for A goes on when A is kicked; A\'s open socket is refused and closed; later turns do not wait for A', async () => {
    const { t, gameId } = await playingGame();
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    b.action('สำรวจตลาด', 'public');
    expect(await accepted(b, 0)).toEqual({ type: 'action_accepted' });
    c.action('เฝ้าประตู', 'public');
    expect(await accepted(c, 0)).toEqual({ type: 'action_accepted' });
    expect(resolveCalls).toBe(0);

    const res = await kick(await admin(), gameId, t.a.memberId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await a.waitFor((m) => m.type === 'error')).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect((await a.closed).code).toBe(4001);

    await b.waitFor((m) => m.type === 'entry' && m.entry.text === 'ผลของเทิร์น');
    expect(resolveCalls).toBe(1);
    const next = ensurePhaseState(server!.orm, gameId, CLOCK);
    expect(next).toMatchObject({ day: 4, phase: 'EOSORIA', turn: 2, status: 'collecting' });
    expect(next.order).toEqual([t.b.memberId, t.c.memberId]);

    // Turn 2 closes with the two who are left.
    const from = b.messages.length;
    b.action('เดินต่อ', 'public');
    c.action('ตามไป', 'public');
    await b.waitFor((m) => m.type === 'entry' && m.entry.text === 'ผลของเทิร์น', from);
    expect(resolveCalls).toBe(2);
  });

  it('C3: kicked while the turn is being resolved → the next turn has no seat for A', async () => {
    const { t, gameId } = await playingGame();
    const release = deferred();
    turnGate = { promise: release.promise, called: deferred() };
    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const [i, c] of clients.entries()) c.action(`ทำสิ่งที่ ${i}`, 'public');
    await turnGate.called.promise;

    expect((await kick(await admin(), gameId, t.c.memberId)).status).toBe(200);
    turnGate = null;
    release.resolve();
    await clients[0]!.waitFor((m) => m.type === 'entry' && m.entry.text === 'ผลของเทิร์น');
    const next = ensurePhaseState(server!.orm, gameId, CLOCK);
    expect(next).toMatchObject({ turn: 2, status: 'collecting' });
    expect(next.order).toEqual([t.a.memberId, t.b.memberId]);
  });

  it('C4: another game\'s member → 404 member_not_found; a second kick → 409 already_kicked; an ended game → 409 already_ended', async () => {
    const token = await admin();
    const one = await lobbyGame('เกมหนึ่ง');
    const two = await lobbyGame('เกมสอง');

    const other = await kick(token, one.gameId, two.b.memberId);
    expect(other.status).toBe(404);
    expect(ApiError.parse(other.body).code).toBe('member_not_found');
    expect(kickedAtOf(two.b.memberId)).toBeNull();
    expect(ApiError.parse((await kick(token, one.gameId, 'no-such-member')).body).code).toBe('member_not_found');
    const noGame = await kick(token, 'no-such-game', one.b.memberId);
    expect(noGame.status).toBe(404);
    expect(ApiError.parse(noGame.body).code).toBe('game_not_found');

    expect((await kick(token, one.gameId, one.b.memberId)).status).toBe(200);
    const twice = await kick(token, one.gameId, one.b.memberId);
    expect(twice.status).toBe(409);
    expect(ApiError.parse(twice.body).code).toBe('already_kicked');

    // Ended: closed by the owner, and a finale.
    expect((await call('POST', `/api/admin/games/${two.gameId}/close`, { token, body: { confirmName: 'เกมสอง' } })).status).toBe(200);
    const { t, gameId } = await playingGame();
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
    for (const [g, m] of [[two.gameId, two.owner.memberId], [gameId, t.b.memberId]] as const) {
      for (const res of [await kick(token, g, m), await renew(token, g)]) {
        expect(res.status).toBe(409);
        expect(ApiError.parse(res.body).code).toBe('already_ended');
      }
      expect(kickedAtOf(m)).toBeNull();
    }
    expect(ApiError.parse((await renew(token, 'no-such-game')).body).code).toBe('game_not_found');
  });

  it('Q-397: the Human GM cannot be kicked (409 not_allowed), so a GM game never waits forever for approvals', async () => {
    const token = await admin();
    const { t, gameId } = await playingGame(true);
    const res = await kick(token, gameId, t.gm!.memberId);
    expect(res.status).toBe(409);
    expect(ApiError.parse(res.body).code).toBe('not_allowed');
    expect(kickedAtOf(t.gm!.memberId)).toBeNull();
    expect(auditRows().filter((r) => r.action === 'kick')).toHaveLength(0);
    expect((await kick(token, gameId, t.a.memberId)).status).toBe(200);
  });

  it('C5: a renewed code joins, the old one does not, and members already in stay', async () => {
    const g = await lobbyGame();
    const res = await renew(await admin(), g.gameId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { inviteCode } = AdminInviteCodeResponse.parse(res.body);
    expect(inviteCode).not.toBe(g.inviteCode);
    expect(inviteOf(g.gameId)).toBe(inviteCode);

    const old = await call('POST', '/api/join', { body: { inviteCode: g.inviteCode, name: 'ซี', pin: '2222' } });
    expect(old.status).toBe(404);
    expect(ApiError.parse(old.body).code).toBe('game_not_found');
    expect((await call('POST', '/api/join', { body: { inviteCode, name: 'ซี', pin: '2222' } })).status).toBe(200);
    for (const seat of [g.owner, g.b]) expect((await call('GET', '/api/game', { token: seat.token })).status).toBe(200);
  });

  it('C6: members lists everyone with role, hasCharacter, ready and kickedAt (kicked ones too), join order', async () => {
    const token = await admin();
    const { t, gameId } = await playingGame(true);
    expect((await kick(token, gameId, t.c.memberId)).status).toBe(200);
    const res = await membersOf(token, gameId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(AdminMembersResponse.parse(res.body).members).toEqual([
      { id: t.gm!.memberId, name: 'จีเอ็ม', role: 'gm', hasCharacter: false, ready: false, kickedAt: null },
      { id: t.a.memberId, name: 'นก', role: 'player', hasCharacter: true, ready: false, kickedAt: null },
      { id: t.b.memberId, name: 'บี', role: 'player', hasCharacter: true, ready: false, kickedAt: null },
      { id: t.c.memberId, name: 'ซี', role: 'player', hasCharacter: true, ready: false, kickedAt: new Date(CLOCK).toISOString() },
    ]);

    const lobby = await lobbyGame();
    const lobbyMembers = AdminMembersResponse.parse((await membersOf(token, lobby.gameId)).body).members;
    expect(lobbyMembers.map((m) => [m.name, m.role, m.hasCharacter])).toEqual([['นก', 'player', false], ['บี', 'player', false]]);
    const missing = await membersOf(token, 'no-such-game');
    expect(missing.status).toBe(404);
    expect(ApiError.parse(missing.body).code).toBe('game_not_found');
  });

  it('C7: a kick and a renew leave one audit row each (action, game, member, time); no invite code in the audit or the log', async () => {
    const printed: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
    }
    const g = await lobbyGame();
    const token = await admin();
    expect((await kick(token, g.gameId, g.b.memberId)).status).toBe(200);
    expect(auditRows()).toHaveLength(1);
    const renewed = AdminInviteCodeResponse.parse((await renew(token, g.gameId)).body).inviteCode;

    const rows = auditRows();
    expect(rows).toEqual([
      { id: 1, action: 'kick', game_id: g.gameId, member_id: g.b.memberId, at: CLOCK },
      { id: 2, action: 'invite_code', game_id: g.gameId, member_id: null, at: CLOCK },
    ]);
    const written = JSON.stringify(rows) + printed.join('\n') + logLines.join('\n');
    for (const code of [g.inviteCode, renewed]) expect(written).not.toContain(code);
  });

  it.skip('C8: lobby of 3 with 2 ready; the admin kicks the one not ready → the game starts (needs ISK-017 ready / auto start)', () => {
    // shortcut: ISK-017 (ready + auto start) is not on develop; the kick already calls the server's onMemberKicked hook,
    // where ISK-017's "re-check the lobby start" goes. Write this test when ISK-017 is merged.
  });

  it('C9: the members answer has no PIN hash, session token or invite code', async () => {
    const g = await lobbyGame();
    const res = await membersOf(await admin(), g.gameId);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    const pinHashes = (server!.db.prepare('select pin_hash as h from member where game_id = ?').all(g.gameId) as { h: string }[]).map((r) => r.h);
    for (const secret of [...pinHashes, g.owner.token, g.b.token, g.inviteCode]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/pin|token|hash|invite/i);
  });
});
