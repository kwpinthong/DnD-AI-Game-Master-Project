import { AdminCorrectionsExportResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { insertEntry } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, startedTable, type Table } from './visibility-fixture.ts';

/**
 * GEN-189: deleting a game cascades its response_vote rows, so before the delete the server keeps a snapshot of
 * every voted AI message (players' names as tokens) with its 👍/👎 counts and verdict, in a table with no
 * foreign keys, exported as JSONL from /admin like the "แก้เป็น" pairs.
 */
const ADMIN_CODE = 'เจ้าของ-ทดสอบ-สแนปช็อต';
const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;
/** Players' real names of `startedTable`: lobby names (นก, บี, ซี) and character names (ลิน, ดาริน, เมฆา). */
const REAL_NAMES = /ลิน|ดาริน|เมฆา|นก|บี|ซี/;

describe('GEN-189 vote snapshot on game delete', { timeout: 60_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${tmp.dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null },
    );
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const vote = (t: Table, who: { token: string }, seq: number, body: unknown) => t.call('PUT', `/api/game/entries/${seq}/vote`, { token: who.token, body });

  /** A started game: an NPC line (👎 👎 👍 → avoid), a feed line (👍 👍 👍 → good) and one line nobody voted on. */
  async function votedGame() {
    const t = await startedTable(server!, false);
    const gameId = (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const everyone = [t.a.memberId, t.b.memberId, t.c.memberId];
    const npc = getGameScenario(server!.orm, gameId)!.npcs[0]!;
    const line = insertEntry(server!.orm, gameId, { kind: 'npc', meta: { npc: { id: npc.id, kind: 'dialogue' } }, at, locationId: null, text: 'ลินจ๋า นกกับดารินขอเตือนนะ' }, everyone, CLOCK).id;
    const feed = insertEntry(server!.orm, gameId, { kind: 'feed', at, locationId: null, text: 'ฝนตกหนักทั่วเมือง บี ซี เมฆา เปียกหมด' }, everyone, CLOCK).id;
    insertEntry(server!.orm, gameId, { kind: 'feed', at, locationId: null, text: 'ไม่มีใครโหวต' }, everyone, CLOCK);
    for (const [who, v] of [[t.a, 'down'], [t.b, 'down'], [t.c, 'up']] as const) expect((await vote(t, who, line, { vote: v, reasons: v === 'down' ? ['too_long'] : [] })).status).toBe(200);
    for (const who of [t.a, t.b, t.c]) expect((await vote(t, who, feed, { vote: 'up' })).status).toBe(200);
    return { t, gameId, npc, line, feed };
  }

  const deleteGame = (t: Table) => t.call('DELETE', '/api/game', { token: t.a.token, body: { confirmName: 'เมืองก่อนอุกกาบาต' } });
  const snapshots = () =>
    server!.db.prepare('select game_id as gameId, entry_id as seq, scene, npc_name as npc, text, up, down, players, verdict from vote_snapshot order by id').all() as Record<string, unknown>[];
  async function adminToken(t: Table) {
    return ((await t.call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body as { token: string }).token;
  }

  it('C1: deleting a game with votes keeps a snapshot of each voted message with its full counts and verdict', async () => {
    const { t, gameId, npc, line, feed } = await votedGame();
    expect(snapshots()).toEqual([]);
    expect((await deleteGame(t)).status).toBe(204);
    expect(server!.db.prepare('select count(*) as n from response_vote where game_id = ?').get(gameId)).toEqual({ n: 0 });
    expect(snapshots()).toEqual([
      { gameId, seq: line, scene: 'npc-dialogue', npc: npc.name, text: '{{PLAYER_1}}จ๋า {{PLAYER_1}}กับ{{PLAYER_2}}ขอเตือนนะ', up: 1, down: 2, players: 3, verdict: 'avoid' },
      { gameId, seq: feed, scene: 'feed', npc: null, text: 'ฝนตกหนักทั่วเมือง {{PLAYER_2}} {{PLAYER_3}} {{PLAYER_3}} เปียกหมด', up: 3, down: 0, players: 3, verdict: 'good' },
    ]);
  });

  it('C1: a refused delete (wrong name, not the owner) keeps no snapshot', async () => {
    const { t } = await votedGame();
    expect((await t.call('DELETE', '/api/game', { token: t.a.token, body: { confirmName: 'ผิด' } })).status).toBe(400);
    expect((await t.call('DELETE', '/api/game', { token: t.b.token, body: { confirmName: 'เมืองก่อนอุกกาบาต' } })).status).toBe(403);
    expect(snapshots()).toEqual([]);
  });

  it('C2: the snapshot holds no player real name or lobby name', async () => {
    const { t } = await votedGame();
    await deleteGame(t);
    const rows = snapshots();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.text).not.toMatch(REAL_NAMES);
    expect(server!.db.prepare('select count(*) as n from member').get()).toEqual({ n: 0 });
  });

  it('C3: the admin JSONL export has every snapshot row; a player is refused', async () => {
    const { t } = await votedGame();
    await deleteGame(t);
    const again = await votedGame();
    await deleteGame(again.t);
    const total = (server!.db.prepare('select count(*) as n from vote_snapshot').get() as { n: number }).n;
    expect(total).toBe(4);

    const admin = await adminToken(again.t);
    const res = await again.t.call('GET', '/api/admin/vote-snapshots-export', { token: admin });
    expect(res.status).toBe(200);
    const out = AdminCorrectionsExportResponse.parse(res.body);
    const lines = out.jsonl.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(out.count).toBe(total);
    expect(lines).toHaveLength(total);
    expect(lines[0]).toEqual({ npc: expect.any(String), scene: 'npc-dialogue', text: '{{PLAYER_1}}จ๋า {{PLAYER_1}}กับ{{PLAYER_2}}ขอเตือนนะ', up: 1, down: 2, players: 3, verdict: 'avoid' });
    expect(lines[1]).toEqual({ npc: null, scene: 'feed', text: 'ฝนตกหนักทั่วเมือง {{PLAYER_2}} {{PLAYER_3}} {{PLAYER_3}} เปียกหมด', up: 3, down: 0, players: 3, verdict: 'good' });
    for (const l of lines) expect(l.text).not.toMatch(REAL_NAMES);

    const live = await startedTable(server!, false);
    expect((await live.call('GET', '/api/admin/vote-snapshots-export', { token: live.a.token })).status).toBe(403);
  });
});
