import { ApiError, JoinResponse, MeResponse } from '@isekai/protocol';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';

const MINUTE = 60_000;

describe('POST /api/join (invite code + name + PIN)', { timeout: 30_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let clock = Date.UTC(2026, 10, 21, 12, 0, 0);

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    clock = Date.UTC(2026, 10, 21, 12, 0, 0);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function start() {
    server = await startServer({ host: '127.0.0.1', port: 0, dbPath: `${dataDir}/isekai.sqlite` }, { now: () => clock });
    return server;
  }

  async function restart() {
    await server?.close();
    return start();
  }

  /** Games are created by GEN-025; here they are seeded straight into the table. */
  function seedGame(running: RunningServer, inviteCode: string, id = `game-${inviteCode}`) {
    running.db.prepare('insert into game (id, invite_code, created_at) values (?, ?, ?)').run(id, inviteCode, clock);
    return id;
  }

  async function join(running: RunningServer, body: unknown) {
    const res = await fetch(`${running.url}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as unknown };
  }

  async function me(running: RunningServer, token: string | undefined) {
    const res = await fetch(`${running.url}/api/me`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as unknown };
  }

  const memberCount = (running: RunningServer) =>
    (running.db.prepare('select count(*) as n from member').get() as { n: number }).n;

  it('C1: a right invite code, a new name and a 4-digit PIN create a member and log in', async () => {
    const running = await start();
    const gameId = seedGame(running, 'K7Q2MX');

    const res = await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' });

    expect(res.status).toBe(200);
    const body = JoinResponse.parse(res.body);
    expect(body.created).toBe(true);
    expect(body.member).toMatchObject({ gameId, name: 'นก' });
    expect(memberCount(running)).toBe(1);

    const session = await me(running, body.token);
    expect(session.status).toBe(200);
    expect(MeResponse.parse(session.body).member).toEqual(body.member);
  });

  it('C2: the same name with the right PIN logs in as the same member', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    const first = JoinResponse.parse((await join(running, { inviteCode: 'K7Q2MX', name: 'Nok', pin: '0420' })).body);

    // Same player typed differently: case, spaces and a dashed lower-case code.
    const res = await join(running, { inviteCode: 'k7q-2mx', name: '  nok ', pin: '0420' });

    expect(res.status).toBe(200);
    const second = JoinResponse.parse(res.body);
    expect(second.created).toBe(false);
    expect(second.member.id).toBe(first.member.id);
    expect(second.member.name).toBe('Nok');
    expect(second.token).not.toBe(first.token);
    expect(memberCount(running)).toBe(1);
    expect(MeResponse.parse((await me(running, second.token)).body).member.id).toBe(first.member.id);
  });

  it('C2: the same name in another game is a different member', async () => {
    const running = await start();
    seedGame(running, 'AAAAAA');
    seedGame(running, 'BBBBBB');
    const a = JoinResponse.parse((await join(running, { inviteCode: 'AAAAAA', name: 'นก', pin: '1111' })).body);

    const b = JoinResponse.parse((await join(running, { inviteCode: 'BBBBBB', name: 'นก', pin: '2222' })).body);

    expect(b.created).toBe(true);
    expect(b.member.id).not.toBe(a.member.id);
  });

  it('C3: an existing name with a wrong PIN is refused with "PIN ไม่ถูกต้อง" and no member is created', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' });

    const res = await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '9999' });

    expect(res.status).toBe(401);
    const body = ApiError.parse(res.body);
    expect(body).toMatchObject({ code: 'wrong_pin', attemptsLeft: 4 });
    expect(body.message).toContain('PIN ไม่ถูกต้อง');
    expect(body).not.toHaveProperty('token');
    expect(memberCount(running)).toBe(1);
  });

  it('C4: after 5 wrong PINs within 10 minutes the 6th try is locked and says when to retry', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' });

    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      clock += 2 * MINUTE - 1_000; // 5 tries spread over just under 10 minutes
      const res = await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '0000' });
      expect(res.status).toBe(401);
      left.push((ApiError.parse(res.body) as { attemptsLeft: number }).attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const lockedAt = clock;

    // 6th try, even with the right PIN.
    clock += MINUTE;
    const sixth = await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' });

    expect(sixth.status).toBe(429);
    const body = ApiError.parse(sixth.body);
    expect(body.code).toBe('locked');
    const retryAt = Date.parse((body as { retryAt: string }).retryAt);
    expect(retryAt).toBe(lockedAt + 10 * MINUTE);
    expect(body.message).toMatch(/ลองใหม่/);
    expect(Number(sixth.headers.get('retry-after'))).toBe((retryAt - clock) / 1000);

    // The lock is kept in the DB: a restart does not clear it.
    const afterRestart = await restart();
    expect((await join(afterRestart, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' })).status).toBe(429);

    // Once the lock time has passed, the right PIN works again and the count starts over.
    clock = retryAt;
    expect((await join(afterRestart, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' })).status).toBe(200);
    const again = await join(afterRestart, { inviteCode: 'K7Q2MX', name: 'นก', pin: '0000' });
    expect(ApiError.parse(again.body)).toMatchObject({ code: 'wrong_pin', attemptsLeft: 4 });
  });

  it('C4: wrong PINs spread over more than 10 minutes do not lock the name', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' });

    for (let i = 0; i < 5; i++) {
      clock += 3 * MINUTE; // the 5th wrong try is 12 minutes after the 1st
      await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '0000' });
    }

    clock += 1_000;
    expect((await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' })).status).toBe(200);
  });

  it('C4: the lock is per name; another player in the same game can still join', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' });
    for (let i = 0; i < 5; i++) await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '0000' });

    expect((await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' })).status).toBe(429);
    expect((await join(running, { inviteCode: 'K7Q2MX', name: 'บี', pin: '5555' })).status).toBe(200);
  });

  it('C5: an invite code that does not exist answers "ไม่พบเกม"', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');

    const res = await join(running, { inviteCode: 'ZZZZZZ', name: 'นก', pin: '1234' });

    expect(res.status).toBe(404);
    const body = ApiError.parse(res.body);
    expect(body.code).toBe('game_not_found');
    expect(body.message).toContain('ไม่พบเกม');
    expect(memberCount(running)).toBe(0);
  });

  it.each([
    ['a 3-digit PIN', { pin: '123' }, 'pin'],
    ['a 7-digit PIN', { pin: '1234567' }, 'pin'],
    ['a PIN with letters', { pin: '12ab' }, 'pin'],
    ['an empty name', { name: '' }, 'name'],
    ['a name over 32 characters', { name: 'x'.repeat(33) }, 'name'],
  ])('C6: %s is refused with the field named', async (_label, patch, field) => {
    const running = await start();
    seedGame(running, 'K7Q2MX');

    const res = await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234', ...patch });

    expect(res.status).toBe(400);
    const body = ApiError.parse(res.body);
    expect(body.code).toBe('invalid_input');
    expect(Object.keys((body as { fields: object }).fields)).toEqual([field]);
    expect(memberCount(running)).toBe(0);
  });

  it('C6: a request with no JSON body names every field', async () => {
    const running = await start();

    const res = await fetch(`${running.url}/api/join`, { method: 'POST' });

    expect(res.status).toBe(400);
    const body = ApiError.parse(await res.json());
    expect(Object.keys((body as { fields: object }).fields).sort()).toEqual(['inviteCode', 'name', 'pin']);
  });

  it('C7: the session survives a server restart', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    const joined = JoinResponse.parse((await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' })).body);

    const restarted = await restart();
    const res = await me(restarted, joined.token);

    expect(res.status).toBe(200);
    expect(MeResponse.parse(res.body).member).toEqual(joined.member);
  });

  it('C7: GET /api/me refuses a missing, unknown or expired token', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    const joined = JoinResponse.parse((await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' })).body);

    expect((await me(running, undefined)).status).toBe(401);
    expect((await me(running, 'not-a-real-token')).status).toBe(401);

    clock = Date.parse(joined.expiresAt);
    const expired = await me(running, joined.token);
    expect(expired.status).toBe(401);
    // ISK-021: a sent token the server no longer knows is session_expired.
    expect(ApiError.parse(expired.body).code).toBe('session_expired');
  });

  it('POST /api/logout ends the session on the server', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    const joined = JoinResponse.parse((await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' })).body);

    const res = await fetch(`${running.url}/api/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${joined.token}` },
    });

    expect(res.status).toBe(204);
    expect((await me(running, joined.token)).status).toBe(401);
  });

  it('C8: the member table holds no plain-text PIN and the session table no plain token', async () => {
    const running = await start();
    seedGame(running, 'K7Q2MX');
    const joined = JoinResponse.parse((await join(running, { inviteCode: 'K7Q2MX', name: 'นก', pin: '482915' })).body);
    await running.close();
    server = undefined;

    const db = new Database(`${dataDir}/isekai.sqlite`, { readonly: true });
    try {
      const members = db.prepare('select * from member').all() as Record<string, unknown>[];
      const sessions = db.prepare('select * from session').all() as Record<string, unknown>[];
      expect(members).toHaveLength(1);
      const cells = [...members, ...sessions].flatMap((row) => Object.values(row).map(String));
      expect(cells.some((cell) => cell.includes('482915'))).toBe(false);
      expect(cells.some((cell) => cell.includes(joined.token))).toBe(false);
      expect(String(members[0]!.pin_hash)).toMatch(/^scrypt\$/);
    } finally {
      db.close();
    }
  });
});
