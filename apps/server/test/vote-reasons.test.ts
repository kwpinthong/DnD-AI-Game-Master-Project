import { AdminCorrectionResponse, AdminCorrectionsExportResponse, AdminDownvotesResponse, ResponseVoteResponse, RoomEntry } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPin } from '../src/auth/pin.ts';
import { insertEntry } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, startedTable, type Table } from './visibility-fixture.ts';

/**
 * GEN-168: after 👎 a player may pick reasons (stored with response_vote, never shown to anyone else); the server
 * owner lists the 👎 messages, saves "แก้เป็น" pairs (the game's message stays as it was) and exports them as JSONL.
 */
const ADMIN_CODE = 'เจ้าของ-ทดสอบ-โหวต';
const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;

describe('GEN-168 👎 reasons + admin "แก้เป็น"', { timeout: 60_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const logs: string[] = [];

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    logs.length = 0;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${tmp.dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: (line) => logs.push(line), rng: null },
    );
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function seeded() {
    const t = await startedTable(server!, false);
    const gameId = (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const everyone = [t.a.memberId, t.b.memberId, t.c.memberId];
    const npc = getGameScenario(server!.orm, gameId)!.npcs[0]!;
    const line = insertEntry(server!.orm, gameId, { kind: 'npc', meta: { npc: { id: npc.id, kind: 'dialogue' } }, at, locationId: null, text: `ลินจ๋า ${npc.name} ขอเตือนนะ` }, everyone, CLOCK).id;
    const feed = insertEntry(server!.orm, gameId, { kind: 'feed', at, locationId: null, text: 'ฝนตกหนักทั่วเมือง' }, everyone, CLOCK).id;
    return { t, gameId, npc, line, feed };
  }

  const vote = (t: Table, who: { token: string }, seq: number, body: unknown) => t.call('PUT', `/api/game/entries/${seq}/vote`, { token: who.token, body });
  const rows = () => server!.db.prepare('select member_id as memberId, source_ref as ref, vote, reasons from response_vote order by member_id').all() as { memberId: string; ref: string; vote: string; reasons: string }[];
  const entryFor = async (t: Table, who: { token: string }, seq: number) => {
    const log = (await t.call('GET', '/api/game/log', { token: who.token })).body as { entries: unknown[] };
    return log.entries.map((e) => RoomEntry.parse(e)).find((e) => e.seq === seq)!;
  };
  async function adminToken(t: Table) {
    const res = await t.call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    return (res.body as { token: string }).token;
  }

  it('C1: 👎 alone saves at once; reasons are optional, several allowed, and sent back to the voter', async () => {
    const { t, line } = await seeded();
    const first = await vote(t, t.a, line, { vote: 'down' });
    expect(first.status).toBe(200);
    expect(ResponseVoteResponse.parse(first.body)).toMatchObject({ myVote: 'down', myReasons: [] });
    const withReasons = await vote(t, t.a, line, { vote: 'down', reasons: ['translation', 'too_long'] });
    expect(ResponseVoteResponse.parse(withReasons.body)).toEqual({ seq: line, myVote: 'down', myReasons: ['translation', 'too_long'] });
    expect(rows()).toEqual([{ memberId: t.a.memberId, ref: `entry-${line}`, vote: 'down', reasons: '["translation","too_long"]' }]);
    expect((await entryFor(t, t.a, line)).myReasons).toEqual(['translation', 'too_long']);
    expect((await vote(t, t.a, line, { vote: 'down', reasons: ['nonsense'] })).status).toBe(400);
  });

  it('C2: switching to 👍 or cancelling clears the reasons', async () => {
    const { t, line } = await seeded();
    await vote(t, t.a, line, { vote: 'down', reasons: ['wrong_story'] });
    const up = ResponseVoteResponse.parse((await vote(t, t.a, line, { vote: 'up', reasons: ['wrong_story'] })).body);
    expect(up).toEqual({ seq: line, myVote: 'up' });
    expect(rows()[0]!.reasons).toBe('[]');
    await vote(t, t.a, line, { vote: 'down', reasons: ['other'] });
    await vote(t, t.a, line, { vote: null });
    expect(rows()).toEqual([]);
    await vote(t, t.a, line, { vote: 'down' });
    expect((await entryFor(t, t.a, line)).myReasons).toEqual([]);
  });

  it('C3: another player never sees someone else\'s reasons', async () => {
    const { t, line } = await seeded();
    await vote(t, t.a, line, { vote: 'down', reasons: ['out_of_character'] });
    const seenByB = await entryFor(t, t.b, line);
    expect(seenByB.myVote).toBeNull();
    expect(seenByB).not.toHaveProperty('myReasons');
    const log = JSON.stringify((await t.call('GET', '/api/game/log', { token: t.b.token })).body);
    expect(log).not.toContain('out_of_character');
  });

  it('C4: admin lists the 👎 messages (with NPC + reasons), saves "แก้เป็น": a pair + an audit line, the game text unchanged', async () => {
    const { t, gameId, npc, line, feed } = await seeded();
    await vote(t, t.a, line, { vote: 'down', reasons: ['translation'] });
    await vote(t, t.b, line, { vote: 'down', reasons: ['translation', 'too_long'] });
    await vote(t, t.c, feed, { vote: 'up' });
    const token = await adminToken(t);
    expect((await t.call('GET', '/api/admin/downvotes', { token: t.a.token })).status).toBe(403);

    const list = AdminDownvotesResponse.parse((await t.call('GET', '/api/admin/downvotes', { token })).body);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({ gameId, seq: line, scene: 'npc-dialogue', npc: { id: npc.id, name: npc.name }, down: 2, reasons: { translation: 2, too_long: 1 }, corrections: [] });

    const before = server!.db.prepare('select text from room_entry where id = ?').get(line);
    const saved = await t.call('POST', '/api/admin/corrections', { token, body: { gameId, seq: line, edited: '  ลินจ๋า ระวังตัวด้วยนะ  ' } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(AdminCorrectionResponse.parse(saved.body).correction).toMatchObject({ original: `ลินจ๋า ${npc.name} ขอเตือนนะ`, edited: 'ลินจ๋า ระวังตัวด้วยนะ', npc: npc.name, scene: 'npc-dialogue', reasons: ['translation', 'too_long'], libraryCandidate: false });
    expect(server!.db.prepare('select text from room_entry where id = ?').get(line)).toEqual(before);
    expect(logs.some((l) => l.startsWith('[admin] correction') && l.includes(`entry ${line}`))).toBe(true);
    expect(AdminDownvotesResponse.parse((await t.call('GET', '/api/admin/downvotes', { token })).body).entries[0]!.corrections).toHaveLength(1);

    for (const body of [{ gameId, seq: line, edited: '   ' }, { gameId, seq: 99_999, edited: 'x' }, { gameId: 'nope', seq: line, edited: 'x' }]) {
      expect((await t.call('POST', '/api/admin/corrections', { token, body })).status).not.toBe(200);
    }
    expect((await t.call('POST', '/api/admin/corrections', { token: t.a.token, body: { gameId, seq: line, edited: 'x' } })).status).toBe(403);
  });

  it('C5: "send to the NPC library" stores the pair as a library candidate only (GEN-151 has no library yet)', async () => {
    const { t, gameId, line } = await seeded();
    const token = await adminToken(t);
    const saved = AdminCorrectionResponse.parse((await t.call('POST', '/api/admin/corrections', { token, body: { gameId, seq: line, edited: 'ฉบับแก้', toLibrary: true } })).body);
    expect(saved.correction.libraryCandidate).toBe(true);
  });

  it('C6: the JSONL export holds every pair, players\' real names swapped for tokens', async () => {
    const { t, gameId, line, feed } = await seeded();
    const token = await adminToken(t);
    await t.call('POST', '/api/admin/corrections', { token, body: { gameId, seq: line, edited: 'ลินจ๋า ดารินก็ด้วย' } });
    await t.call('POST', '/api/admin/corrections', { token, body: { gameId, seq: feed, edited: 'ฝนตกพรำ ๆ' } });
    const res = await t.call('GET', '/api/admin/corrections-export', { token });
    expect(res.status).toBe(200);
    const out = AdminCorrectionsExportResponse.parse(res.body);
    const lines = out.jsonl.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(out.count).toBe(2);
    expect(lines).toHaveLength(2);
    expect(out.jsonl).not.toMatch(/ลิน|ดาริน|นก/);
    expect(lines[0]).toMatchObject({ scene: 'npc-dialogue', original: expect.stringContaining('{{PLAYER_1}}'), edited: '{{PLAYER_1}}จ๋า {{PLAYER_2}}ก็ด้วย' });
    expect(lines[1]).toMatchObject({ scene: 'feed', npc: null, original: 'ฝนตกหนักทั่วเมือง', edited: 'ฝนตกพรำ ๆ' });
    expect((await t.call('GET', '/api/admin/corrections-export', { token: t.a.token })).status).toBe(403);
  });
});
