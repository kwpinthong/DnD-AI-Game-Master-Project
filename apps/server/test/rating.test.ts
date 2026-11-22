import { ApiError, GameLogResponse, GameRatingResponse, type GameRatingView } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePhaseState, recordAction, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-078: after the game ended every member gives one score 1–10 (+ an optional comment) and a 👍 on the
 * action → result rows (rulings) they liked. A ruling is an action that stood, named by its `sourceRef`
 * (`${day}-${phase}-${turn}-${actionSeq}`, ADR GEN-077); only what the end page shows can get a 👍.
 */

const RATING = '/api/game/rating';
const likePath = (ref: string) => `${RATING}/likes/${encodeURIComponent(ref)}`;

describe('GEN-078 rating + 👍 after the end', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    server = await startTestServer(dataDir);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const ratingRows = () => server!.db.prepare('select member_id as memberId, score, comment from game_rating order by member_id').all() as { memberId: string; score: number; comment: string }[];
  const voteRows = () => server!.db.prepare('select member_id as memberId, source_ref as sourceRef from ruling_vote').all() as { memberId: string; sourceRef: string }[];

  /** Day 1 EOSORIA turn 1: A acts in public, B in secret; day 3 NOCTHERION turn 2: C in secret. */
  function seedActions(t: Table) {
    const gameId = gameIdOf(t);
    recordAction(server!.orm, gameId, { day: 1, phase: 'EOSORIA', turn: 1 }, t.a.memberId, { text: 'สำรวจตลาด', visibility: 'public', rest: false }, CLOCK);
    recordAction(server!.orm, gameId, { day: 1, phase: 'EOSORIA', turn: 1 }, t.b.memberId, { text: 'แอบหยิบถุงเงิน', visibility: 'secret', rest: false }, CLOCK);
    recordAction(server!.orm, gameId, { day: 3, phase: 'NOCTHERION', turn: 2 }, t.c.memberId, { text: 'แอบฟังหลังกำแพง', visibility: 'secret', rest: false }, CLOCK);
  }

  function endGame(t: Table) {
    const gameId = gameIdOf(t);
    savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
  }

  /** A started table of 3 players (no Human GM) with actions, ended. */
  async function endedTable(humanGm = false): Promise<Table> {
    const t = await startedTable(server!, humanGm);
    seedActions(t);
    endGame(t);
    return t;
  }

  async function view(t: Table, who: { token: string }): Promise<GameRatingView> {
    const res = await t.call('GET', RATING, { token: who.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return GameRatingResponse.parse(res.body).rating;
  }

  async function rate(t: Table, who: { token: string }, body: unknown): Promise<GameRatingView> {
    const res = await t.call('PUT', RATING, { token: who.token, body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return GameRatingResponse.parse(res.body).rating;
  }

  /** The refs the end page shows: each player's revealed Secret actions. */
  async function revealedRefs(t: Table, who: Seat): Promise<Record<string, string[]>> {
    const log = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: who.token })).body);
    return Object.fromEntries(log.reveal!.players.map((p) => [p.memberId, p.secretActions.map((s) => s.sourceRef ?? 'missing')]));
  }

  it('C1: a member of an ended game sends 9 + a comment: it is saved and the view says they rated', async () => {
    const t = await endedTable();
    expect((await view(t, t.a)).mine).toBeNull();
    const rating = await rate(t, t.a, { score: 9, comment: '  สนุกมาก ทำอีกนะ  ' });
    expect(rating).toMatchObject({ mine: { score: 9, comment: 'สนุกมาก ทำอีกนะ' }, raters: 1, members: 3, average: 9 });
    expect(await view(t, t.a)).toEqual(rating);
    // Someone else sees the game score but not A's comment as their own.
    expect(await view(t, t.b)).toMatchObject({ mine: null, raters: 1, members: 3, average: 9 });
    expect(ratingRows()).toEqual([{ memberId: t.a.memberId, score: 9, comment: 'สนุกมาก ทำอีกนะ' }]);
  });

  it('C1: the comment is optional', async () => {
    const t = await endedTable();
    expect((await rate(t, t.a, { score: 8 })).mine).toEqual({ score: 8, comment: '' });
  });

  it.each([
    ['0', { score: 0 }],
    ['11', { score: 11 }],
    ['8.5', { score: 8.5 }],
    ['missing', {}],
    ['null', { score: null }],
    ['empty text', { score: '' }],
    ['a string', { score: '9' }],
  ])('C2: score %s is refused with a Thai message and nothing is saved', async (_label, body) => {
    const t = await endedTable();
    const res = await t.call('PUT', RATING, { token: t.a.token, body });
    expect(res.status).toBe(400);
    const error = ApiError.parse(res.body);
    expect(error).toMatchObject({ code: 'invalid_input', fields: { score: 'เลือกคะแนน 1–10' } });
    expect(ratingRows()).toEqual([]);
    expect((await view(t, t.a)).mine).toBeNull();
  });

  it('C2: no body at all, and a comment over 500 characters, are refused too', async () => {
    const t = await endedTable();
    expect((await t.call('PUT', RATING, { token: t.a.token })).status).toBe(400);
    const long = await t.call('PUT', RATING, { token: t.a.token, body: { score: 9, comment: 'ก'.repeat(501) } });
    expect(long.status).toBe(400);
    expect(ApiError.parse(long.body)).toMatchObject({ code: 'invalid_input', fields: { comment: 'ความเห็นยาวได้ไม่เกิน 500 ตัวอักษร' } });
    expect((await rate(t, t.b, { score: 9, comment: 'ก'.repeat(500) })).mine!.comment).toHaveLength(500);
    expect(ratingRows()).toHaveLength(1);
  });

  it('C3: the edges 1 and 10 are accepted', async () => {
    const t = await endedTable();
    expect((await rate(t, t.a, { score: 1 })).mine!.score).toBe(1);
    expect((await rate(t, t.b, { score: 10 })).mine!.score).toBe(10);
    expect(ratingRows().map((r) => r.score).sort((x, y) => x - y)).toEqual([1, 10]);
  });

  it('C4: while the game is not ended, rating and 👍 are refused and nothing is saved', async () => {
    const t = await startedTable(server!, false);
    seedActions(t);
    for (const [method, path, body] of [
      ['GET', RATING, undefined],
      ['PUT', RATING, { score: 9 }],
      ['PUT', likePath('1-EOSORIA-1-1'), undefined],
      ['DELETE', likePath('1-EOSORIA-1-1'), undefined],
    ] as const) {
      const res = await t.call(method, path, { token: t.a.token, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(ApiError.parse(res.body)).toMatchObject({ code: 'not_allowed', message: 'ให้คะแนนได้เมื่อเกมจบแล้วเท่านั้น' });
    }
    expect(ratingRows()).toEqual([]);
    expect(voteRows()).toEqual([]);
  });

  it('C4: a game still in the lobby refuses too', async () => {
    const call = (await endedTable()).call;
    const created = await call('POST', '/api/games', { body: { createCode: CREATE_CODE, gameName: 'เกมใหม่', mode: 'online', humanGm: false, name: 'คนใหม่', pin: '1234' } });
    const token = (created.body as { token: string }).token;
    expect((await call('PUT', RATING, { token, body: { score: 9 } })).status).toBe(409);
    expect(ratingRows()).toEqual([]);
  });

  it('C5: someone who is not a member of a game gets 403 and nothing is saved', async () => {
    const t = await endedTable();
    for (const token of [undefined, 'not-a-token']) {
      for (const [method, path, body] of [
        ['GET', RATING, undefined],
        ['PUT', RATING, { score: 9 }],
        ['PUT', likePath('1-EOSORIA-1-1'), undefined],
        ['DELETE', likePath('1-EOSORIA-1-1'), undefined],
      ] as const) {
        const res = await t.call(method, path, { ...(token ? { token } : {}), ...(body ? { body } : {}) });
        expect(res.status, `${method} ${path} as ${token}`).toBe(403);
        expect(ApiError.parse(res.body).code).toBe('forbidden');
      }
    }
    // A member the owner removed is not a member any more (the session row is kept here on purpose).
    server!.db.prepare('update member set kicked_at = ? where id = ?').run(CLOCK, t.c.memberId);
    expect((await t.call('PUT', RATING, { token: t.c.token, body: { score: 9 } })).status).toBe(403);
    expect(ratingRows()).toEqual([]);
    expect(voteRows()).toEqual([]);
  });

  it('C5: a member of another game cannot reach this game: their score lands in their own game only', async () => {
    const t = await endedTable();
    const other = await endedTable();
    await rate(other, other.a, { score: 3 });
    expect(await view(t, t.a)).toMatchObject({ mine: null, raters: 0, average: null });
    expect(ratingRows()).toEqual([{ memberId: other.a.memberId, score: 3, comment: '' }]);
  });

  it('C6: sending again replaces the old score and comment (one member = one score)', async () => {
    const t = await endedTable();
    await rate(t, t.a, { score: 9, comment: 'รอบแรก' });
    await rate(t, t.b, { score: 8 });
    const again = await rate(t, t.a, { score: 7, comment: 'คิดใหม่แล้ว' });
    expect(again).toMatchObject({ mine: { score: 7, comment: 'คิดใหม่แล้ว' }, raters: 2, average: 7.5 });
    expect(ratingRows().filter((r) => r.memberId === t.a.memberId)).toEqual([{ memberId: t.a.memberId, score: 7, comment: 'คิดใหม่แล้ว' }]);
    expect(ratingRows()).toHaveLength(2);
    // A second send without a comment clears it: the whole rating is replaced.
    expect((await rate(t, t.a, { score: 7 })).mine).toEqual({ score: 7, comment: '' });
  });

  it('Q-163 / Q-164: the score is the average of who rated; the Human GM is a member and may rate', async () => {
    const t = await endedTable(true);
    expect(await view(t, t.gm!)).toMatchObject({ raters: 0, members: 4, average: null, eligible: false, blocker: 'too_few_raters' });
    // 1 of 4 rated: under half.
    expect(await rate(t, t.gm!, { score: 10 })).toMatchObject({ raters: 1, average: 10, eligible: false, blocker: 'too_few_raters' });
    // 2 of 4 = half, 8.5 > 8.
    expect(await rate(t, t.a, { score: 7 })).toMatchObject({ raters: 2, average: 8.5, eligible: true, blocker: null });
    // 3 raters, exactly 8.0: not above 8.
    expect(await rate(t, t.b, { score: 7 })).toMatchObject({ raters: 3, average: 8, eligible: false, blocker: 'score_too_low' });
  });

  it('C7: a 👍 on a ruling adds one to its count; taking it back removes it; twice by one member counts once', async () => {
    const t = await endedTable();
    const refs = await revealedRefs(t, t.a);
    const ref = refs[t.b.memberId]![0]!;
    expect(ref).toMatch(/^1-EOSORIA-1-\d+$/);
    expect(await view(t, t.a)).toMatchObject({ liked: [], thumbs: {} });

    const put = async (who: Seat, r: string) => GameRatingResponse.parse((await t.call('PUT', likePath(r), { token: who.token })).body).rating;
    const del = async (who: Seat, r: string) => GameRatingResponse.parse((await t.call('DELETE', likePath(r), { token: who.token })).body).rating;

    expect(await put(t.a, ref)).toMatchObject({ liked: [ref], thumbs: { [ref]: 1 } });
    // R3: the same member again = still one.
    expect(await put(t.a, ref)).toMatchObject({ liked: [ref], thumbs: { [ref]: 1 } });
    expect(await put(t.c, ref)).toMatchObject({ liked: [ref], thumbs: { [ref]: 2 } });
    expect(await view(t, t.b)).toMatchObject({ liked: [], thumbs: { [ref]: 2 } });
    expect(voteRows()).toHaveLength(2);

    // Pressing again = cancel.
    expect(await del(t.a, ref)).toMatchObject({ liked: [], thumbs: { [ref]: 1 } });
    expect(await del(t.a, ref)).toMatchObject({ liked: [], thumbs: { [ref]: 1 } });
    expect(await del(t.c, ref)).toEqual(expect.objectContaining({ liked: [], thumbs: {} }));
    expect(voteRows()).toEqual([]);
  });

  it('C7: every revealed Secret action carries its own ref, and a public action that stood can get a 👍 too', async () => {
    const t = await endedTable();
    const refs = await revealedRefs(t, t.b);
    expect(refs[t.a.memberId]).toEqual([]);
    expect(refs[t.b.memberId]).toHaveLength(1);
    expect(refs[t.c.memberId]).toEqual([expect.stringMatching(/^3-NOCTHERION-2-\d+$/)]);
    // A's public action of the same turn as B's secret one: same turn, another seq.
    const seqOfB = Number(refs[t.b.memberId]![0]!.split('-')[3]);
    const publicRef = `1-EOSORIA-1-${seqOfB - 1}`;
    const res = await t.call('PUT', likePath(publicRef), { token: t.c.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(voteRows()).toEqual([{ memberId: t.c.memberId, sourceRef: publicRef }]);
  });

  it('C7: a ref that names no ruling of this game is 404 and saves nothing', async () => {
    const t = await endedTable();
    for (const ref of ['1-EOSORIA-1-99', '2-EOSORIA-1-1', '1-MORNING-1-1', 'nonsense', '1-EOSORIA-3-1']) {
      for (const method of ['PUT', 'DELETE']) {
        const res = await t.call(method, likePath(ref), { token: t.a.token });
        expect(res.status, `${method} ${ref}`).toBe(404);
        expect(ApiError.parse(res.body)).toMatchObject({ code: 'ruling_not_found' });
      }
    }
    expect(voteRows()).toEqual([]);
  });

  it('C7: a Secret action the end page does not reveal (its player was removed) cannot get a 👍', async () => {
    const t = await endedTable();
    const ref = (await revealedRefs(t, t.a))[t.c.memberId]![0]!;
    server!.db.prepare('update member set kicked_at = ? where id = ?').run(CLOCK, t.c.memberId);
    expect((await revealedRefs(t, t.a))[t.c.memberId]).toBeUndefined();
    expect((await t.call('PUT', likePath(ref), { token: t.a.token })).status).toBe(404);
    expect(voteRows()).toEqual([]);
  });

  it('C8: after a restart the scores, comments and 👍 are all still there', async () => {
    const t = await endedTable();
    const ref = (await revealedRefs(t, t.a))[t.b.memberId]![0]!;
    await rate(t, t.a, { score: 9, comment: 'จำไว้นะ' });
    await rate(t, t.b, { score: 10 });
    await t.call('PUT', likePath(ref), { token: t.a.token });
    await t.call('PUT', likePath(ref), { token: t.c.token });
    const before = await Promise.all([t.a, t.b, t.c].map((who) => view(t, who)));

    await server!.close();
    server = await startTestServer(dataDir);
    const again = { ...t, call: (await import('./visibility-fixture.ts')).caller(server) };
    expect(await Promise.all([t.a, t.b, t.c].map((who) => view(again, who)))).toEqual(before);
    expect(before[0]).toMatchObject({ mine: { score: 9, comment: 'จำไว้นะ' }, liked: [ref], thumbs: { [ref]: 2 }, raters: 2, average: 9.5 });
  });
});
