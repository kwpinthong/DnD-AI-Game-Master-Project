import { ApiError, GmVotesResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertEntry } from '../src/room/store.ts';
import { voteVerdict } from '../src/room/vote.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/** GEN-126: the Human GM reads the 👍 / 👎 counts per AI message, with the Q-286 good-example and Q-287 avoid flags. */
describe('GEN-126 C3 the Q-286 / Q-287 rules', () => {
  // [players, up, down, good, avoid]
  const cases: [number, number, number, boolean, boolean][] = [
    [2, 1, 0, false, false], // 1 of 2 is half, not more (the non-voter counts as 👎 for Q-286)
    [2, 2, 0, true, false],
    [2, 0, 1, false, false], // a tie does not mark "to avoid"
    [2, 0, 2, false, true],
    [3, 2, 0, true, false], // the non-voter counts as 👎, still 2 of 3 > half
    [3, 1, 0, false, false], // 2 non-voters are not real 👎 for Q-287
    [3, 0, 2, false, true],
    [3, 1, 1, false, false],
    [4, 2, 0, false, false], // tie
    [4, 2, 2, false, false], // tie both ways
    [4, 3, 1, true, false],
    [4, 0, 3, false, true],
    [5, 3, 0, true, false],
    [5, 2, 2, false, false],
    [5, 0, 3, false, true],
    [5, 1, 2, false, false], // 2 non-voters + 2 👎 = 4 of 5 "not 👍", but only 2 real 👎
    [0, 0, 0, false, false],
  ];
  it.each(cases)('%i players, %i up, %i down → good %s, avoid %s', (players, up, down, good, avoid) => {
    expect(voteVerdict({ up, down }, players)).toEqual({ good, avoid });
  });
});

describe('GEN-126 GET /api/game/gm/votes', { timeout: 60_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    server = await startTestServer(tmp.dir);
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;
  const vote = (t: Table, who: { token: string }, seq: number, v: 'up' | 'down') => t.call('PUT', `/api/game/entries/${seq}/vote`, { token: who.token, body: { vote: v } });

  async function seeded() {
    const t = await startedTable(server!, true);
    const gameId = (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const everyone = [t.a.memberId, t.b.memberId, t.c.memberId, t.gm!.memberId];
    const feed = (text: string) => insertEntry(server!.orm, gameId, { kind: 'feed', at, locationId: null, text }, everyone, CLOCK).id;
    const liked = feed('ระฆังดังทั่วเมือง');
    const disliked = feed('ฝนตกหนัก');
    const split = feed('ตลาดเงียบ');
    const silent = feed('ไม่มีใครโหวต');
    for (const [who, seq, v] of [
      [t.a, liked, 'up'],
      [t.b, liked, 'up'],
      [t.a, disliked, 'down'],
      [t.c, disliked, 'down'],
      [t.a, split, 'up'],
      [t.b, split, 'down'],
    ] as const) expect((await vote(t, who, seq, v)).status).toBe(200);
    return { t, liked, disliked, split, silent };
  }

  it('C1: the Human GM gets ถูกใจ / ไม่ถูกใจ per voted message and the flags, out of all 3 players', async () => {
    const { t, liked, disliked, split } = await seeded();
    const res = await t.call('GET', '/api/game/gm/votes', { token: t.gm!.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = GmVotesResponse.parse(res.body);
    expect(body.players).toBe(3);
    expect(body.entries.map((e) => [e.seq, e.text, e.up, e.down, e.good, e.avoid])).toEqual([
      [liked, 'ระฆังดังทั่วเมือง', 2, 0, true, false],
      [disliked, 'ฝนตกหนัก', 0, 2, false, true],
      [split, 'ตลาดเงียบ', 1, 1, false, false],
    ]);
    expect(body.entries[0]).toMatchObject({ kind: 'feed', at });
  });

  it('C2: a player asking for the counts gets 403 and nothing else; on their entries they see only their own vote', async () => {
    const { t, liked } = await seeded();
    const log = (await t.call('GET', '/api/game/log', { token: t.c.token })).body as { entries: { seq: number; myVote?: unknown; up?: unknown }[] };
    expect(log.entries.find((e) => e.seq === liked)).toMatchObject({ myVote: null });
    expect(log.entries.find((e) => e.seq === liked)).not.toHaveProperty('up');
    for (const seat of [t.a, t.b, t.c]) {
      const res = await t.call('GET', '/api/game/gm/votes', { token: seat.token });
      expect(res.status).toBe(403);
      expect(ApiError.parse(res.body).code).toBe('forbidden');
      expect(JSON.stringify(res.body)).not.toMatch(/"up"|"down"/);
    }
  });
});
