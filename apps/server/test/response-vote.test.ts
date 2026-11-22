import { ApiError, GameLogResponse, ResponseVoteResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertEntry } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/** GEN-107: players rate every AI-written room entry with up / down; one vote per member, bound to the entry's response id. */
const votePath = (seq: number) => `/api/game/entries/${seq}/vote`;

describe('GEN-107 vote on AI GM entries', { timeout: 60_000 }, () => {
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
  const voteRows = () => server!.db.prepare('select member_id as memberId, source_ref as sourceRef, vote from response_vote').all() as { memberId: string; sourceRef: string; vote: string }[];
  const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;

  /** A narration for A only, a town feed for everyone, a template (fallback) narration, and A's own whisper to B. */
  function seed(t: Table) {
    const gameId = gameIdOf(t);
    const everyone = [t.a.memberId, t.b.memberId, t.c.memberId, ...(t.gm ? [t.gm.memberId] : [])];
    const narration = insertEntry(server!.orm, gameId, { kind: 'narration', at, locationId: null, text: 'ลินเดินเข้าตลาด' }, [t.a.memberId], CLOCK);
    const feed = insertEntry(server!.orm, gameId, { kind: 'feed', at, locationId: null, text: 'ระฆังดังทั่วเมือง' }, everyone, CLOCK);
    const template = insertEntry(server!.orm, gameId, { kind: 'narration', at, locationId: null, text: 'เทมเพลต', fallback: 'timeout' }, [t.a.memberId], CLOCK);
    const whisper = insertEntry(server!.orm, gameId, { kind: 'whisper', at, locationId: null, text: 'กระซิบ', fromMemberId: t.a.memberId, toMemberId: t.b.memberId }, [t.a.memberId, t.b.memberId], CLOCK);
    return { narration: narration.id, feed: feed.id, template: template.id, whisper: whisper.id };
  }

  const vote = (t: Table, who: { token: string }, seq: number, v: unknown) => t.call('PUT', votePath(seq), { token: who.token, body: { vote: v } });
  const logEntries = async (t: Table, who: { token: string }) => GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: who.token })).body).entries;

  it('C1: ถูกใจ stores up for that member and answers the new state', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    const res = await vote(t, t.a, e.narration, 'up');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ResponseVoteResponse.parse(res.body)).toEqual({ seq: e.narration, myVote: 'up' });
    expect(voteRows()).toEqual([{ memberId: t.a.memberId, sourceRef: `entry-${e.narration}`, vote: 'up' }]);
  });

  it('C2: null cancels the vote (no row)', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    await vote(t, t.a, e.narration, 'up');
    const res = await vote(t, t.a, e.narration, null);
    expect(ResponseVoteResponse.parse(res.body)).toEqual({ seq: e.narration, myVote: null });
    expect(voteRows()).toEqual([]);
  });

  it('C3: down replaces up, exactly one vote remains; each member has their own', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    await vote(t, t.a, e.feed, 'up');
    await vote(t, t.a, e.feed, 'down');
    await vote(t, t.b, e.feed, 'up');
    expect(voteRows().sort((x, y) => x.memberId.localeCompare(y.memberId))).toEqual(
      [
        { memberId: t.a.memberId, sourceRef: `entry-${e.feed}`, vote: 'down' },
        { memberId: t.b.memberId, sourceRef: `entry-${e.feed}`, vote: 'up' },
      ].sort((x, y) => x.memberId.localeCompare(y.memberId)),
    );
  });

  it('C4: B cannot vote A\'s private narration (403, nothing stored) and does not see it', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    const res = await vote(t, t.b, e.narration, 'up');
    expect(res.status).toBe(403);
    expect(ApiError.parse(res.body).code).toBe('forbidden');
    expect(voteRows()).toEqual([]);
    expect((await logEntries(t, t.b)).map((x) => x.seq)).not.toContain(e.narration);
  });

  it('C5: votes come back on the entries of the game log, only for the voter and only on AI-written kinds', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    await vote(t, t.a, e.narration, 'up');
    await vote(t, t.b, e.feed, 'down');
    const a = await logEntries(t, t.a);
    expect(a.find((x) => x.seq === e.narration)?.myVote).toBe('up');
    expect(a.find((x) => x.seq === e.feed)?.myVote).toBeNull();
    const b = await logEntries(t, t.b);
    expect(b.find((x) => x.seq === e.feed)?.myVote).toBe('down');
    // a whisper (player text) and a server template are not AI-written: no myVote at all
    expect(a.find((x) => x.seq === e.whisper)).not.toHaveProperty('myVote');
    expect(a.find((x) => x.seq === e.template)).not.toHaveProperty('myVote');
  });

  it('C6: the human GM cannot vote (403) and their entries carry no myVote', async () => {
    const t = await startedTable(server!, true);
    const e = seed(t);
    const res = await vote(t, t.gm!, e.feed, 'up');
    expect(res.status).toBe(403);
    expect(voteRows()).toEqual([]);
    expect((await logEntries(t, t.gm!)).find((x) => x.seq === e.feed)).not.toHaveProperty('myVote');
  });

  it('C7: after the game ended voting and changing still work', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    server!.db.prepare("update game_phase set state = json_set(state, '$.status', 'finale') where game_id = ?").run(gameIdOf(t));
    expect((await vote(t, t.a, e.narration, 'up')).status).toBe(200);
    expect((await vote(t, t.a, e.narration, 'down')).status).toBe(200);
    expect(voteRows().map((r) => r.vote)).toEqual(['down']);
  });

  it('C8: an id that does not exist, a whisper and a template entry are 404 response_not_found and create nothing', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    for (const seq of [99999, e.whisper, e.template]) {
      const res = await vote(t, t.a, seq, 'up');
      expect(res.status, String(seq)).toBe(404);
      expect(ApiError.parse(res.body).code).toBe('response_not_found');
    }
    expect(voteRows()).toEqual([]);
  });

  it('a bad vote value is 400 and no token is 403', async () => {
    const t = await startedTable(server!, false);
    const e = seed(t);
    const bad = await vote(t, t.a, e.feed, 'meh');
    expect(bad.status).toBe(400);
    expect(ApiError.parse(bad.body).code).toBe('invalid_input');
    expect((await t.call('PUT', votePath(e.feed), { body: { vote: 'up' } })).status).toBe(403);
    expect(voteRows()).toEqual([]);
  });
});
