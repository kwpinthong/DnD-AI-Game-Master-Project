import { LearningLibraryResponse, NpcLibraryResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { hashPin } from '../src/auth/pin.ts';
import { examplesFor } from '../src/learning/examples.ts';
import { profileOf } from '../src/learning/style.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, CREATE_CODE, type Call } from './visibility-fixture.ts';

/**
 * GEN-084: the Learning library of the server owner (Q-168): every kept entry by its 5 types with its source game and
 * date, 👍 / 👎 / players on good_example / avoid; delete one entry or a whole source game (a tombstone: never used again,
 * a rebuild does not bring it back); admin code only. The NPC line library tab gets GEN-081's good NPC lines (Q-322).
 */
const ADMIN_CODE = 'ทดสอบ-คลังความรู้-084';
const DAY = 86_400_000;

describe('GEN-084 Learning library API', { timeout: 120_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let call: Call;

  beforeEach(async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    server = await startServer(
      { host: '127.0.0.1', port: 0, dbPath: `${tmp.dir}/isekai.sqlite`, createCodeHash: await hashPin(CREATE_CODE), adminCodeHash: await hashPin(ADMIN_CODE) },
      { now: () => CLOCK, ai: loadAiConfig({ AI_PROVIDER: 'mock' }), aiLog: () => {}, rng: null },
    );
    call = caller(server);
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function admin() {
    const res = await call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } });
    expect(res.status).toBe(200);
    return (res.body as { token: string }).token;
  }

  /** One row as the learning modules store it. */
  function entry(gameId: string, gameName: string, type: string, sourceRef: string, content: string, detail: Record<string, unknown>, extra: { tags?: string[]; status?: string; score?: number | null; at?: number } = {}) {
    return Number(
      server!.db
        .prepare('insert into learning_entry (type, source_game_id, source_game_name, source_score, source_ref, content, tags, detail, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(type, gameId, gameName, extra.score === undefined ? null : extra.score, sourceRef, content, JSON.stringify(extra.tags ?? []), JSON.stringify(detail), extra.status ?? 'active', extra.at ?? CLOCK).lastInsertRowid,
    );
  }

  const vote = (kind: string, up: number, down: number, more: Record<string, unknown> = {}) => ({ sourceRef: 'entry-1', kind, npcId: null, up, down, players: 4, ...more });

  /** One entry of each of the 5 types in game g-1, one good_example in g-2. */
  function seedAll() {
    return {
      lore: entry('g-1', 'คืนจันทราโลหิต', 'lore', 'lore-1', 'เมืองรอดเพราะม่านปาฏิหาริย์', { endingPath: 'good', npcIds: ['noa'] }, { tags: ['ending_good'], score: 8.5 }),
      feedback: entry('g-1', 'คืนจันทราโลหิต', 'feedback_note', 'feedback', 'อยากให้บอกเบาะแสชัดขึ้น', { fromComments: 2 }, { score: 8.5 }),
      good: entry('g-1', 'คืนจันทราโลหิต', 'good_example', 'entry-7', 'ผู้เล่นเดินเข้าลานตลาด', vote('narration', 3, 0), { tags: ['steal'] }),
      avoid: entry('g-1', 'คืนจันทราโลหิต', 'avoid', 'entry-8', 'บรรยายยืดยาว', vote('narration', 0, 3), { tags: ['steal'] }),
      ruling: entry('g-1', 'คืนจันทราโลหิต', 'good_example', 'ruling-1-EOSORIA-1-4', 'แอบขโมยถุงเงิน → ยาก สำเร็จ', vote('ruling', 3, 1, { sourceRef: 'ruling-1-EOSORIA-1-4', check: 'ladder', dcLabel: 'ยาก', d20: 14, result: 'success' }), { tags: ['steal'] }),
      style: entry('g-1', 'คืนจันทราโลหิต', 'style', 'member-m1', 'มักลงมือแบบลับ ถนัด steal', { playerKey: 'k-1', verbCounts: { steal: 3 }, actions: 4, secret: 3 }, { tags: ['steal'] }),
      other: entry('g-2', 'เมืองก่อนอุกกาบาต', 'good_example', 'entry-9', 'ฉากขโมยที่ลุ้นมาก', vote('narration', 4, 0), { tags: ['steal'], at: CLOCK + DAY }),
    };
  }

  const library = async (token: string) => {
    const res = await call('GET', '/api/admin/learning', { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return LearningLibraryResponse.parse(res.body);
  };

  it('C1: the entries by 5 types with the source game name and date; good / avoid carry 👍 / 👎 / players', async () => {
    seedAll();
    const lib = await library(await admin());
    expect(lib.counts).toEqual({ lore: 1, feedback_note: 1, good_example: 3, avoid: 1, style: 1 });
    expect(new Set(lib.entries.map((e) => e.type))).toEqual(new Set(['lore', 'feedback_note', 'good_example', 'avoid', 'style']));
    for (const e of lib.entries) expect(e.sourceGameName).toBe(e.sourceGameId === 'g-1' ? 'คืนจันทราโลหิต' : 'เมืองก่อนอุกกาบาต');
    expect(lib.entries.find((e) => e.sourceGameId === 'g-2')!.createdAt).toBe(CLOCK + DAY);
    const avoid = lib.entries.find((e) => e.type === 'avoid')!;
    expect(avoid.type === 'avoid' && avoid.detail).toMatchObject({ up: 0, down: 3, players: 4, kind: 'narration' });
    const ruling = lib.entries.find((e) => e.type === 'good_example' && e.detail.kind === 'ruling')!;
    expect(ruling.type === 'good_example' && ruling.detail).toMatchObject({ up: 3, down: 1, players: 4, dcLabel: 'ยาก', d20: 14, result: 'success' });
    const style = lib.entries.find((e) => e.type === 'style')!;
    expect(style.type === 'style' && style.detail).toEqual({ topVerbs: ['steal'], secretShare: 0.75 });
    expect(JSON.stringify(lib)).not.toContain('k-1'); // the player key never leaves the server
  });

  it('C2: no entry → an empty library (the page shows its empty state)', async () => {
    expect(await library(await admin())).toEqual({ entries: [], counts: { lore: 0, feedback_note: 0, good_example: 0, avoid: 0, style: 0 } });
  });

  it('C3: a deleted entry leaves the list and is no longer retrieved for the prompt; deleting it again is 404', async () => {
    const ids = seedAll();
    const token = await admin();
    const query = { tags: ['steal'], sourceGameIds: ['g-1'], good: 5, avoid: 5 };
    expect(examplesFor(server!.orm, query).good.map((e) => e.id)).toContain(ids.good);
    const res = await call('DELETE', `/api/admin/learning/${ids.good}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = LearningLibraryResponse.parse(res.body);
    expect(after.entries.map((e) => e.id)).not.toContain(String(ids.good));
    expect((await library(token)).entries.map((e) => e.id)).not.toContain(String(ids.good));
    expect(examplesFor(server!.orm, query).good.map((e) => e.id)).not.toContain(ids.good);
    // A deleted style entry leaves the player's profile (the style section of the prompt).
    expect(profileOf(server!.orm, 'k-1')).not.toBeNull();
    expect((await call('DELETE', `/api/admin/learning/${ids.style}`, { token })).status).toBe(200);
    expect(profileOf(server!.orm, 'k-1')).toBeNull();
    expect((await call('DELETE', `/api/admin/learning/${ids.good}`, { token })).status).toBe(404);
    expect((await call('DELETE', '/api/admin/learning/nope', { token })).status).toBe(404);
  });

  it('C4: without the admin code the library and both deletes are 403 and nothing is deleted', async () => {
    const ids = seedAll();
    for (const [method, path] of [
      ['GET', '/api/admin/learning'],
      ['DELETE', `/api/admin/learning/${ids.good}`],
      ['DELETE', '/api/admin/learning/games/g-1'],
    ] as const) {
      for (const token of [undefined, 'not-a-token']) {
        const res = await call(method, path, token ? { token } : {});
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await library(await admin())).entries).toHaveLength(7);
  });

  it('C6: deleting a whole source game deletes every entry of it, the other game stays; unknown game = 404', async () => {
    const ids = seedAll();
    const token = await admin();
    const res = await call('DELETE', '/api/admin/learning/games/g-1', { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(LearningLibraryResponse.parse(res.body).entries.map((e) => e.id)).toEqual([String(ids.other)]);
    expect(examplesFor(server!.orm, { tags: ['steal'], sourceGameIds: ['g-1', 'g-2'], good: 5, avoid: 5 }).good.map((e) => e.id)).toEqual([ids.other]);
    expect((await call('DELETE', '/api/admin/learning/games/g-1', { token })).status).toBe(404);
  });

  it('C7: the NPC line library carries the good NPC lines of GEN-081 as candidates', async () => {
    server!.db.prepare("insert into learning_entry (type, source_game_id, source_game_name, source_score, source_ref, content, tags, detail, status, created_at) values ('good_example', 'g-1', 'คืนจันทราโลหิต', null, 'entry-12', ?, '[\"npc\"]', ?, 'active', ?)").run(
      '{{n:noa}} ยิ้มบาง ๆ',
      JSON.stringify({ sourceRef: 'entry-12', kind: 'dialogue', npcId: 'noa', up: 3, down: 0, players: 4 }),
      CLOCK,
    );
    const res = await call('GET', '/api/admin/npc-library', { token: await admin() });
    expect(res.status).toBe(200);
    expect(NpcLibraryResponse.parse(res.body).goodLines).toEqual([{ gameId: 'g-1', seq: 12, npc: { id: 'noa', name: 'noa' }, text: '{{n:noa}} ยิ้มบาง ๆ', up: 3 }]);
  });
});
