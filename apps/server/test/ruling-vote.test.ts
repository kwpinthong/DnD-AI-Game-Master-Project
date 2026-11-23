import { ApiError, GameLogResponse, GameRatingResponse, type GameRatingView } from '@isekai/protocol';
import { voteVerdict } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rulingVotes } from '../src/rating/store.ts';
import { ensurePhaseState, recordAction, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-171: the end page's rulings get the 👍/👎 set of GEN-107 (press again = cancel, the other = switch),
 * stored in response_vote as `ruling-${sourceRef}`; players only, each sees only their own vote.
 */
const votePath = (ref: string) => `/api/game/rating/votes/${encodeURIComponent(ref)}`;

describe('GEN-171 ruling 👍/👎 on the end page', { timeout: 60_000 }, () => {
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
  const rows = () =>
    server!.db.prepare('select member_id as memberId, source_ref as sourceRef, vote from response_vote order by member_id').all() as { memberId: string; sourceRef: string; vote: string }[];

  async function table(humanGm = false, ended = true): Promise<{ t: Table; ref: string }> {
    const t = await startedTable(server!, humanGm);
    const gameId = gameIdOf(t);
    recordAction(server!.orm, gameId, { day: 1, phase: 'EOSORIA', turn: 1 }, t.b.memberId, { text: 'แอบหยิบถุงเงิน', visibility: 'secret', rest: false }, CLOCK);
    if (ended) savePhaseState(server!.orm, gameId, { ...ensurePhaseState(server!.orm, gameId, CLOCK), day: 12, phase: 'NOCTHERION', turn: 2, status: 'finale' }, CLOCK);
    const seq = (server!.db.prepare('select seq from phase_action where game_id = ?').get(gameId) as { seq: number }).seq;
    return { t, ref: `1-EOSORIA-1-${seq}` };
  }

  async function vote(t: Table, who: Seat, ref: string, v: 'up' | 'down' | null): Promise<GameRatingView> {
    const res = await t.call('PUT', votePath(ref), { token: who.token, body: { vote: v } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return GameRatingResponse.parse(res.body).rating;
  }

  it('C1: 👎 on a ruling = one row vote = down for that member, ref ruling-…', async () => {
    const { t, ref } = await table();
    expect((await vote(t, t.a, ref, 'down')).myVotes).toEqual({ [ref]: 'down' });
    expect(rows()).toEqual([{ memberId: t.a.memberId, sourceRef: `ruling-${ref}`, vote: 'down' }]);
  });

  it('C2 / C3: the other button switches the single row; null cancels it', async () => {
    const { t, ref } = await table();
    await vote(t, t.a, ref, 'up');
    expect((await vote(t, t.a, ref, 'down')).myVotes).toEqual({ [ref]: 'down' });
    expect(rows()).toEqual([{ memberId: t.a.memberId, sourceRef: `ruling-${ref}`, vote: 'down' }]);
    expect((await vote(t, t.a, ref, null)).myVotes).toEqual({});
    expect(rows()).toEqual([]);
  });

  it('C4: the Human GM gets 403 and no row', async () => {
    const { t, ref } = await table(true);
    const res = await t.call('PUT', votePath(ref), { token: t.gm!.token, body: { vote: 'up' } });
    expect(res.status).toBe(403);
    expect(ApiError.parse(res.body).code).toBe('forbidden');
    expect(rows()).toEqual([]);
    const viewOf = async (s: { token: string }) => GameRatingResponse.parse((await t.call('GET', '/api/game/rating', { token: s.token })).body).rating;
    expect((await viewOf(t.gm!)).canVote).toBe(false);
    expect((await viewOf(t.a)).canVote).toBe(true);
  });

  it('C5: no member token = 403; a ruling not in the game (or one of another game) = 404; a bad body = 400', async () => {
    const { t, ref } = await table();
    const other = await table();
    expect((await t.call('PUT', votePath(ref), { body: { vote: 'up' } })).status).toBe(403);
    // A member's token only reaches their own game, so a ref that is not one of its rulings is 404.
    const res = await other.t.call('PUT', votePath('1-EOSORIA-1-99'), { token: other.t.a.token, body: { vote: 'up' } });
    expect(res.status).toBe(404);
    expect(ApiError.parse(res.body).code).toBe('ruling_not_found');
    expect((await t.call('PUT', votePath(ref), { token: t.a.token, body: { vote: 'meh' } })).status).toBe(400);
    expect(rows()).toEqual([]);
  });

  it('C6: while the game is still playing = 409, no row', async () => {
    const { t, ref } = await table(false, false);
    const res = await t.call('PUT', votePath(ref), { token: t.a.token, body: { vote: 'up' } });
    expect(res.status).toBe(409);
    expect(rows()).toEqual([]);
  });

  it('C8: B sees only their own vote, never A\'s or any total', async () => {
    const { t, ref } = await table();
    await vote(t, t.a, ref, 'up');
    const res = await t.call('GET', '/api/game/rating', { token: t.b.token });
    const view = GameRatingResponse.parse(res.body).rating;
    expect(view.myVotes).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain(ref);
    expect(view).not.toHaveProperty('thumbs');
    expect(view).not.toHaveProperty('liked');
    // The log of the end page does not carry votes either.
    const log = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.b.token })).body);
    expect(JSON.stringify(log)).not.toMatch(/"(up|down|myVotes|thumbs)"/);
  });

  it('C9: rulingVotes judges each ruling with voteVerdict out of the players of the game', async () => {
    expect(voteVerdict({ players: 4, up: 3, down: 0 })).toBe('good');
    expect(voteVerdict({ players: 4, up: 2, down: 2 })).toBe('none');
    const { t, ref } = await table(true);
    await vote(t, t.a, ref, 'up');
    await vote(t, t.b, ref, 'up');
    await vote(t, t.c, ref, 'down');
    expect(rulingVotes(server!.orm, gameIdOf(t)).get(ref)).toEqual({ up: 2, down: 1, good: true, avoid: false });
  });

  it('GEN-079 C13: a game rated 4.00 on average still keeps a ruling 👍 by most players as good (no score gate)', async () => {
    const { t, ref } = await table(true);
    for (const who of [t.a, t.b, t.c, t.gm!]) expect((await t.call('PUT', '/api/game/rating', { token: who.token, body: { score: 4 } })).status).toBe(200);
    const rating = GameRatingResponse.parse((await t.call('GET', '/api/game/rating', { token: t.a.token })).body).rating;
    expect(rating.average).toBe(4);
    await vote(t, t.a, ref, 'up');
    await vote(t, t.b, ref, 'up');
    expect(rulingVotes(server!.orm, gameIdOf(t)).get(ref)).toMatchObject({ good: true, avoid: false });
  });

  it('GEN-079 C10: a kicked player leaves the divisor (and their vote leaves the count)', async () => {
    const { t, ref } = await table(true);
    await vote(t, t.a, ref, 'up');
    await vote(t, t.c, ref, 'down');
    // 3 players: 👍1 of 3 is not good.
    expect(rulingVotes(server!.orm, gameIdOf(t)).get(ref)).toMatchObject({ up: 1, down: 1, good: false });
    server!.db.prepare('update member set kicked_at = ? where id = ?').run(CLOCK, t.c.memberId);
    // players = 2 (a, b): 👍1 of 2 is exactly half → still none; b's 👍 makes it good.
    expect(rulingVotes(server!.orm, gameIdOf(t)).get(ref)).toMatchObject({ up: 1, down: 0, good: false, avoid: false });
    await vote(t, t.b, ref, 'up');
    expect(rulingVotes(server!.orm, gameIdOf(t)).get(ref)).toMatchObject({ up: 2, down: 0, good: true });
  });

  it('GEN-126 stays whole: ruling votes do not show up (or break) GET /api/game/gm/votes', async () => {
    const { t, ref } = await table(true);
    await vote(t, t.a, ref, 'up');
    const res = await t.call('GET', '/api/game/gm/votes', { token: t.gm!.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: [] });
  });
});
