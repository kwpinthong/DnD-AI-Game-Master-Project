import { AdminFeedbackResponse, AdminSessionResponse, ApiError, CreateGameResponse, FeedbackRow } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, CREATE_CODE, startedTable, type Call, type Table } from './visibility-fixture.ts';

/**
 * ISK-010: players send a bug report / idea (POST /api/feedback) and the server owner reads it in /admin
 * (GET /api/admin/feedback) and moves its status (PATCH /api/admin/feedback/:id, audited).
 */

const ADMIN_CODE = 'เจ้าของ-รายงาน-2026';
const TEN_MINUTES = 10 * 60 * 1000;
const BUG = { type: 'bug', text: 'ปุ่มส่งค้าง', page: 'play' } as const;

describe('ISK-010 Report & Feedback', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let clock = CLOCK;
  let call: Call;
  let logLines: string[] = [];
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    clock = CLOCK;
    logLines = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function boot() {
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => clock, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: (line) => logLines.push(line), backupLog: (line) => logLines.push(line), rng: null },
    );
    call = caller(server);
    return server;
  }

  async function adminToken(): Promise<string> {
    const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return AdminSessionResponse.parse(res.body).token;
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;

  /** A started table at day 3 SOLARION turn 2. */
  async function playingTable(): Promise<Table> {
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, clock), day: 3, phase: 'SOLARION', turn: 2 }, clock);
    return t;
  }

  async function send(token: string | undefined, body: unknown) {
    return call('POST', '/api/feedback', { ...(token ? { token } : {}), body });
  }

  async function sent(token: string, body: unknown): Promise<FeedbackRow> {
    const res = await send(token, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return FeedbackRow.parse(res.body);
  }

  const errorOf = (res: { body: unknown }) => ApiError.parse(res.body).code;
  const rows = () => server!.db.prepare('select * from feedback order by id').all() as Record<string, unknown>[];

  it('C1: a player at day 3 SOLARION turn 2 sends a bug: 201, the row has day 3 SOLARION turn 2, status new', async () => {
    await boot();
    const t = await playingTable();
    const row = await sent(t.a.token, BUG);
    expect(row).toMatchObject({ gameId: gameIdOf(t), memberId: t.a.memberId, type: 'bug', text: 'ปุ่มส่งค้าง', status: 'new' });
    expect(row.context).toEqual({ day: 3, period: 'SOLARION', turn: 2, page: 'play', userAgent: expect.any(String) });
    expect(rows()).toEqual([expect.objectContaining({ id: row.id, game_id: gameIdOf(t), member_id: t.a.memberId, day: 3, period: 'SOLARION', turn: 2, status: 'new', created_at: CLOCK })]);
  });

  it('C2: no session (or an unknown token) is 401 and nothing is stored', async () => {
    await boot();
    // ISK-021: an unknown token is session_expired, no token stays unauthorized.
    for (const [res, code] of [[await send(undefined, BUG), 'unauthorized'], [await send('not-a-token', BUG), 'session_expired']] as const) {
      expect(res.status).toBe(401);
      expect(errorOf(res)).toBe(code);
    }
    expect(rows()).toEqual([]);
  });

  it('C3: empty / blank text is 400 text_required; 1000 code points is 201; 1001 is 400 text_too_long', async () => {
    await boot();
    const t = await playingTable();
    for (const text of ['', '    ', undefined]) {
      const res = await send(t.a.token, { ...BUG, text });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('text_required');
    }
    expect((await sent(t.a.token, { ...BUG, text: '😀'.repeat(1000) })).text).toBe('😀'.repeat(1000));
    const long = await send(t.a.token, { ...BUG, text: 'ก'.repeat(1001) });
    expect(long.status).toBe(400);
    expect(errorOf(long)).toBe('text_too_long');
    expect(rows()).toHaveLength(1);
  });

  it('C4: type "spam" is 400 invalid_type', async () => {
    await boot();
    const t = await playingTable();
    const res = await send(t.a.token, { ...BUG, type: 'spam' });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_type');
    expect(rows()).toEqual([]);
  });

  it('C5: the 6th report within 10 minutes is 429 rate_limited; once 10 minutes passed it goes through', async () => {
    await boot();
    const t = await playingTable();
    for (let i = 0; i < 5; i++) await sent(t.a.token, { ...BUG, text: `ครั้งที่ ${i + 1}` });
    const sixth = await send(t.a.token, BUG);
    expect(sixth.status).toBe(429);
    expect(errorOf(sixth)).toBe('rate_limited');
    // Counted per member: B still can.
    await sent(t.b.token, BUG);
    clock = CLOCK + TEN_MINUTES - 1;
    expect((await send(t.a.token, BUG)).status).toBe(429);
    clock = CLOCK + TEN_MINUTES;
    await sent(t.a.token, BUG);
    expect(rows().filter((r) => r.member_id === t.a.memberId)).toHaveLength(6);
  });

  it('C6: day / period / turn / game / member in the body are ignored: the game state and the session win', async () => {
    await boot();
    const t = await playingTable();
    const row = await sent(t.a.token, { ...BUG, day: 99, period: 'NOCTHERION', turn: 1, gameId: 'g-other', memberId: t.b.memberId, status: 'done' });
    expect(row).toMatchObject({ gameId: gameIdOf(t), memberId: t.a.memberId, status: 'new', context: { day: 3, period: 'SOLARION', turn: 2 } });
  });

  it('C7: admin GET ?status=new lists only new reports, newest first; no admin session is 401, a player token 403', async () => {
    await boot();
    const t = await playingTable();
    const first = await sent(t.a.token, { ...BUG, text: 'แรก' });
    clock += 1000;
    const second = await sent(t.b.token, { ...BUG, text: 'สอง' });
    clock += 1000;
    const third = await sent(t.c.token, { ...BUG, text: 'สาม' });
    const admin = await adminToken();
    expect((await call('PATCH', `/api/admin/feedback/${second.id}`, { token: admin, body: { status: 'reviewing' } })).status).toBe(200);

    const res = await call('GET', '/api/admin/feedback?status=new', { token: admin });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(AdminFeedbackResponse.parse(res.body).feedback.map((f) => f.id)).toEqual([third.id, first.id]);
    const all = AdminFeedbackResponse.parse((await call('GET', '/api/admin/feedback', { token: admin })).body).feedback;
    expect(all.map((f) => f.id)).toEqual([third.id, second.id, first.id]);

    const none = await call('GET', '/api/admin/feedback');
    expect(none.status).toBe(401);
    expect(errorOf(none)).toBe('unauthorized');
    expect((await call('PATCH', `/api/admin/feedback/${first.id}`, { body: { status: 'done' } })).status).toBe(401);
    expect((await call('GET', '/api/admin/feedback', { token: t.a.token })).status).toBe(403);
    expect((await call('PATCH', `/api/admin/feedback/${first.id}`, { token: t.a.token, body: { status: 'done' } })).status).toBe(403);
  });

  it('C7: GET returns at most the latest 200 rows', async () => {
    await boot();
    const insert = server!.db.prepare("insert into feedback (game_id, member_id, type, text, page, status, created_at, updated_at) values ('g', 'm', 'bug', ?, 'play', 'new', ?, ?)");
    for (let i = 1; i <= 205; i++) insert.run(`#${i}`, i, i);
    const list = AdminFeedbackResponse.parse((await call('GET', '/api/admin/feedback', { token: await adminToken() })).body).feedback;
    expect(list).toHaveLength(200);
    expect(list[0]!.text).toBe('#205');
    expect(list[199]!.text).toBe('#6');
  });

  it('C8: admin PATCH done changes the status and updatedAt and writes 1 audit row; an unknown id is 404', async () => {
    await boot();
    const t = await playingTable();
    const row = await sent(t.a.token, BUG);
    const admin = await adminToken();
    clock = CLOCK + 5000;
    const res = await call('PATCH', `/api/admin/feedback/${row.id}`, { token: admin, body: { status: 'done' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(FeedbackRow.parse(res.body)).toMatchObject({ id: row.id, status: 'done', createdAt: new Date(CLOCK).toISOString(), updatedAt: new Date(CLOCK + 5000).toISOString() });
    expect(rows()[0]).toMatchObject({ status: 'done', updated_at: CLOCK + 5000 });
    expect(server!.db.prepare('select feedback_id as feedbackId, action, "from", "to", at from feedback_audit').all()).toEqual([
      { feedbackId: row.id, action: 'status', from: 'new', to: 'done', at: CLOCK + 5000 },
    ]);

    const missing = await call('PATCH', '/api/admin/feedback/99999', { token: admin, body: { status: 'done' } });
    expect(missing.status).toBe(404);
    expect(errorOf(missing)).toBe('feedback_not_found');
    expect((await call('PATCH', '/api/admin/feedback/abc', { token: admin, body: { status: 'done' } })).status).toBe(404);
    expect(server!.db.prepare('select count(*) as n from feedback_audit').get()).toEqual({ n: 1 });
  });

  it('C9: from the Lobby before the start: 201 with day / period / turn null; from the end page: 201 page ending', async () => {
    await boot();
    const created = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'ยังไม่เริ่ม', mode: 'online', humanGm: false, name: 'นก', pin: '1234' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const lobby = CreateGameResponse.parse(created.body);
    const early = await sent(lobby.token, { type: 'idea', text: 'อยากเลือกสีชื่อ', page: 'lobby' });
    expect(early.context).toMatchObject({ day: null, period: null, turn: null, page: 'lobby' });
    // Sending feedback does not make the game's turn state.
    expect(server!.db.prepare('select count(*) as n from game_phase where game_id = ?').get(lobby.game.id)).toEqual({ n: 0 });

    const t = await playingTable();
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, clock), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, clock);
    const ending = await sent(t.a.token, { type: 'other', text: 'จบสวยมาก', page: 'ending' });
    expect(ending.context).toMatchObject({ day: 12, period: 'NOCTHERION', turn: 2, page: 'ending' });
  });

  it('C10: page "x" is 400 invalid_page; a 400-character userAgent is kept as 300', async () => {
    await boot();
    const t = await playingTable();
    const bad = await send(t.a.token, { ...BUG, page: 'x' });
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toBe('invalid_page');
    const row = await sent(t.a.token, { ...BUG, userAgent: 'U'.repeat(400) });
    expect(row.context.userAgent).toBe('U'.repeat(300));
    expect(rows()[0]!.user_agent).toBe('U'.repeat(300));
  });

  it('C11: PATCH status "closed" is 400 invalid_status; GET ?type=idea lists only ideas', async () => {
    await boot();
    const t = await playingTable();
    const bug = await sent(t.a.token, BUG);
    const idea = await sent(t.a.token, { ...BUG, type: 'idea', text: 'อยากได้แผนที่' });
    await sent(t.a.token, { ...BUG, type: 'other', text: 'อื่นๆ' });
    const admin = await adminToken();
    const closed = await call('PATCH', `/api/admin/feedback/${bug.id}`, { token: admin, body: { status: 'closed' } });
    expect(closed.status).toBe(400);
    expect(errorOf(closed)).toBe('invalid_status');
    expect(rows()[0]!.status).toBe('new');
    expect(server!.db.prepare('select count(*) as n from feedback_audit').get()).toEqual({ n: 0 });

    const ideas = AdminFeedbackResponse.parse((await call('GET', '/api/admin/feedback?type=idea', { token: admin })).body).feedback;
    expect(ideas.map((f) => f.id)).toEqual([idea.id]);
    const both = AdminFeedbackResponse.parse((await call('GET', '/api/admin/feedback?type=idea&status=done', { token: admin })).body).feedback;
    expect(both).toEqual([]);
    expect((await call('GET', '/api/admin/feedback?type=spam', { token: admin })).status).toBe(400);
    expect((await call('GET', '/api/admin/feedback?status=closed', { token: admin })).status).toBe(400);
  });

  it('C12: sending reaches no other player socket, adds no room entry, and no log line carries the text', async () => {
    const consoleLines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(' ')));
    }
    await boot();
    const t = await playingTable();
    const room = await openRoom(server!, { token: t.b.token });
    sockets.push(room);
    await room.waitFor(isReady);
    const framesBefore = room.raw.length;
    const entriesBefore = server!.db.prepare('select count(*) as n from room_entry').get();

    const secret = 'บั๊กลับ-ISK010-<script>alert(1)</script>';
    const row = await sent(t.a.token, { ...BUG, text: secret });
    // Kept raw: escaping is the page's job.
    expect(row.text).toBe(secret);
    expect(rows()[0]!.text).toBe(secret);
    await new Promise((r) => setTimeout(r, 300));

    expect(room.raw.slice(framesBefore).filter((f) => f.includes('ISK010'))).toEqual([]);
    expect(server!.db.prepare('select count(*) as n from room_entry').get()).toEqual(entriesBefore);
    expect([...logLines, ...consoleLines].filter((l) => l.includes('ISK010') || l.includes('บั๊กลับ'))).toEqual([]);
  });

  it('C14: 5 reports, then a server restart: the 6th within 10 minutes is still 429', async () => {
    await boot();
    const t = await playingTable();
    for (let i = 0; i < 5; i++) await sent(t.a.token, { ...BUG, text: `ครั้งที่ ${i + 1}` });
    await server!.close();
    clock = CLOCK + 60_000;
    await boot();
    const res = await send(t.a.token, BUG);
    expect(res.status).toBe(429);
    expect(errorOf(res)).toBe('rate_limited');
  });
});
