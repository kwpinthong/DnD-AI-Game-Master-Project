import { NpcLibraryResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPin } from '../src/auth/pin.ts';
import { loadAiConfig } from '../src/ai/config.ts';
import { DIALOGUE_BLOCK, loadWorld } from '../src/gm/context.ts';
import { dialoguePrompt } from '../src/gm/npc-examples.ts';
import { npcPrompt } from '../src/gm/npc-lines.ts';
import { insertEntry } from '../src/room/store.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, CREATE_CODE, DARIN, LIN, MEKHA, startedTable, type Table } from './visibility-fixture.ts';

/**
 * GEN-151: the server owner's NPC example library. Messages with a 👍 (GEN-107) and "แก้เป็น" pairs marked for the
 * library (GEN-168, Q-337: at once) become examples of one NPC, tagged with a scene kind, stored with tokens only;
 * the dialogue prompt carries ≤ 3 of each NPC here (with its persona) in a cacheable block after the rules.
 */
const ADMIN_CODE = 'เจ้าของ-ทดสอบ-คลัง';
const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;

describe('GEN-151 NPC example library', { timeout: 60_000 }, () => {
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

  async function seeded() {
    const t = await startedTable(server!, false);
    const gameId = (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const everyone = [t.a.memberId, t.b.memberId, t.c.memberId];
    const npc = getGameScenario(server!.orm, gameId)!.npcs[0]!;
    const say = (text: string) => insertEntry(server!.orm, gameId, { kind: 'npc', meta: { npc: { id: npc.id, kind: 'dialogue' } }, at, locationId: null, text }, everyone, CLOCK).id;
    const line = say(`${LIN.name}จ๋า ${npc.name} ขอเตือนนะ`);
    const feed = insertEntry(server!.orm, gameId, { kind: 'feed', at, locationId: null, text: 'ฝนตกหนักทั่วเมือง' }, everyone, CLOCK).id;
    const token = (await t.call('POST', '/api/admin/session', { body: { code: ADMIN_CODE } })).body as { token: string };
    return { t, gameId, npc, say, line, feed, everyone, admin: token.token };
  }

  const vote = (t: Table, who: { token: string }, seq: number, v: 'up' | 'down') => t.call('PUT', `/api/game/entries/${seq}/vote`, { token: who.token, body: { vote: v } });
  const library = async (t: Table, token: string) => NpcLibraryResponse.parse((await t.call('GET', '/api/admin/npc-library', { token })).body);
  const examplesOf = (lib: NpcLibraryResponse, npcId: string) => lib.npcs.find((n) => n.npcId === npcId)?.examples ?? [];

  /** The dialogue prompt of the NPC `npcId` alone at the place, as the turn loop builds it. */
  function promptFor(gameId: string, npcId: string, members: readonly string[]) {
    const world = loadWorld(server!.orm, gameId, server!.assets);
    const npcs = npcPrompt(server!.orm, server!.assets, world, world.npcs.filter((n) => n.id === npcId), new Set([npcId]), members);
    return dialoguePrompt(server!.orm, server!.assets, world, npcs);
  }

  it('admin: lists 👍 messages, adds one to an NPC with a scene kind (tokens only), players get 403', async () => {
    const { t, gameId, npc, line, feed, admin } = await seeded();
    await vote(t, t.a, line, 'up');
    await vote(t, t.b, feed, 'up');
    for (const [method, path] of [['GET', '/api/admin/npc-library'], ['POST', '/api/admin/npc-library'], ['DELETE', '/api/admin/npc-library/1']] as const) {
      expect((await t.call(method, path, { token: t.a.token, body: { from: 'vote', gameId, seq: line, npcId: npc.id, scene: 'npc-dialogue' } })).status).toBe(403);
    }

    const before = await library(t, admin);
    expect(before.npcs.every((n) => n.examples.length === 0)).toBe(true);
    expect(before.upvoted.map((e) => e.seq).sort()).toEqual([line, feed].sort());
    expect(before.upvoted.find((e) => e.seq === line)).toMatchObject({ gameId, scene: 'npc-dialogue', npc: { id: npc.id, name: npc.name }, up: 1, inLibrary: false });
    expect(before.npcChoices).toEqual(expect.arrayContaining([{ id: npc.id, name: npc.name }]));

    const added = await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq: line, npcId: npc.id, scene: 'npc-dialogue' } });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const [example] = examplesOf(NpcLibraryResponse.parse(added.body), npc.id);
    expect(example).toMatchObject({ npcId: npc.id, scene: 'npc-dialogue', source: 'vote', gameId, seq: line });
    expect(example!.text).toBe(`{{p:player}}จ๋า {{n:${npc.id}}} ขอเตือนนะ`);
    // Adding twice keeps one; a narration with a 👍 may go to an NPC too, with its own scene kind.
    await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq: line, npcId: npc.id, scene: 'npc-dialogue' } });
    const both = await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq: feed, npcId: npc.id, scene: 'feed' } });
    expect(examplesOf(NpcLibraryResponse.parse(both.body), npc.id).map((e) => e.scene)).toEqual(['npc-dialogue', 'feed']);
    expect((await library(t, admin)).upvoted.find((e) => e.seq === line)!.inLibrary).toBe(true);

    // A message without a 👍, an unknown NPC: refused.
    const other = insertEntry(server!.orm, gameId, { kind: 'feed', at, locationId: null, text: 'ไม่มีใครชอบ' }, [t.a.memberId], CLOCK).id;
    expect((await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq: other, npcId: npc.id, scene: 'feed' } })).status).toBe(404);
    expect((await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq: line, npcId: 'nobody', scene: 'feed' } })).status).toBe(404);
  });

  it('Q-337: a "แก้เป็น" pair sent to the library enters it at once with the edited text; one of a narration waits for an NPC', async () => {
    const { t, gameId, npc, line, feed, admin } = await seeded();
    await t.call('POST', '/api/admin/corrections', { token: admin, body: { gameId, seq: line, edited: `${DARIN.name} ระวังตัวด้วยนะ`, toLibrary: true } });
    await t.call('POST', '/api/admin/corrections', { token: admin, body: { gameId, seq: line, edited: 'ไม่ส่งเข้าคลัง' } });
    const lib = await library(t, admin);
    expect(examplesOf(lib, npc.id)).toEqual([expect.objectContaining({ source: 'correction', scene: 'npc-dialogue', text: '{{p:player}} ระวังตัวด้วยนะ' })]);

    const saved = (await t.call('POST', '/api/admin/corrections', { token: admin, body: { gameId, seq: feed, edited: 'ฝนตกพรำ ๆ', toLibrary: true } })).body as { correction: { id: number } };
    const waiting = await library(t, admin);
    expect(waiting.candidates.map((c) => c.id)).toEqual([saved.correction.id]);
    const added = NpcLibraryResponse.parse((await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'correction', correctionId: saved.correction.id, npcId: npc.id } })).body);
    expect(examplesOf(added, npc.id).map((e) => e.text)).toEqual(['{{p:player}} ระวังตัวด้วยนะ', 'ฝนตกพรำ ๆ']);
    expect(added.candidates).toEqual([]);
  });

  it('C1: the dialogue prompt carries at most 3 examples of the NPC, after the rules, with its persona', async () => {
    const { t, gameId, npc, say, admin, everyone } = await seeded();
    for (const i of [1, 2, 3, 4, 5]) {
      const seq = say(`ตัวอย่างที่ ${i}`);
      await vote(t, t.a, seq, 'up');
      await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq, npcId: npc.id, scene: 'npc-dialogue' } });
    }
    const { system, npcs } = promptFor(gameId, npc.id, everyone);
    expect(system[0]).toBe(DIALOGUE_BLOCK);
    const examples = system.at(-1)!;
    expect(examples.cache).toBe(true);
    expect(examples.text).toContain(`{{n:${npc.id}}}`);
    expect(examples.text.match(/ตัวอย่างที่ \d/g)).toHaveLength(3);
    const persona = npcs.find((n) => n.id === npc.id);
    // The persona moved to the cached block (when the NPC has one), not repeated per turn.
    expect(persona?.persona ?? null).toBeNull();
  });

  it('C2: an NPC without a library: no example block, the context as before', async () => {
    const { gameId, npc, everyone } = await seeded();
    const world = loadWorld(server!.orm, gameId, server!.assets);
    const npcs = npcPrompt(server!.orm, server!.assets, world, world.npcs.filter((n) => n.id === npc.id), new Set([npc.id]), everyone);
    const out = dialoguePrompt(server!.orm, server!.assets, world, npcs);
    expect(out.system).toEqual([DIALOGUE_BLOCK]);
    expect(out.npcs).toEqual(npcs);
  });

  it('C3: two calls for the same NPC start byte-identical', async () => {
    const { t, gameId, npc, line, admin, everyone } = await seeded();
    await vote(t, t.a, line, 'up');
    await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq: line, npcId: npc.id, scene: 'npc-dialogue' } });
    const first = JSON.stringify(promptFor(gameId, npc.id, everyone).system);
    const second = JSON.stringify(promptFor(gameId, npc.id, everyone).system);
    expect(second).toBe(first);
  });

  it('C4: an example with a real name is swapped for a token before the prompt', async () => {
    const { gameId, npc, everyone } = await seeded();
    // A row written with names (an older or hand-made one): the prompt still never carries them.
    server!.db
      .prepare("insert into npc_example (npc_id, npc_name, scene, text, source, game_id, entry_id, created_at) values (?, ?, 'npc-dialogue', ?, 'vote', ?, 1, 0)")
      .run(npc.id, npc.name, `${MEKHA.name} ฟังนะ ${npc.name} รู้ทุกอย่าง`, gameId);
    const { system } = promptFor(gameId, npc.id, everyone);
    const all = JSON.stringify(system);
    for (const name of [LIN.name, DARIN.name, MEKHA.name, npc.name]) expect(all).not.toContain(name);
    expect(system.at(-1)!.text).toContain(`{{n:${npc.id}}} รู้ทุกอย่าง`);
  });

  it('C5: a deleted example is not in the next prompt', async () => {
    const { t, gameId, npc, line, admin, everyone } = await seeded();
    await vote(t, t.a, line, 'up');
    const added = NpcLibraryResponse.parse((await t.call('POST', '/api/admin/npc-library', { token: admin, body: { from: 'vote', gameId, seq: line, npcId: npc.id, scene: 'npc-dialogue' } })).body);
    expect(promptFor(gameId, npc.id, everyone).system.at(-1)!.text).toContain('ขอเตือนนะ');
    const id = examplesOf(added, npc.id)[0]!.id;
    const removed = await t.call('DELETE', `/api/admin/npc-library/${id}`, { token: admin });
    expect(removed.status).toBe(200);
    expect(examplesOf(NpcLibraryResponse.parse(removed.body), npc.id)).toEqual([]);
    expect(JSON.stringify(promptFor(gameId, npc.id, everyone).system)).not.toContain('ขอเตือนนะ');
    expect((await t.call('DELETE', `/api/admin/npc-library/${id}`, { token: admin })).status).toBe(404);
  });
});
