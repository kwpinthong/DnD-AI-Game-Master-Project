import { socialTitle } from '@isekai/rules';
import type { RoomEntry, RoomServerMessage } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roomEntry } from '../src/db/schema.ts';
import { entryViewOf } from '../src/room/entry-view.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { DARIN, MEKHA, startedTable, startTestServer } from './visibility-fixture.ts';

/**
 * GEN-154: a `player` entry is the action as typed; a real name in it (another player's, an NPC's) reaches a
 * viewer who does not know that person as the alias, per viewer at read time. The actor introducing themself
 * still shows (GEN-117); the Human GM reads the original.
 */
describe('GEN-154 real names in player entries', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }
  async function playTurn(clients: RoomClient[], texts: string[]) {
    const from = clients.map((c) => c.messages.length);
    for (const [i, c] of clients.entries()) {
      c.action(texts[i]!, 'public');
      await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from[i]!);
    }
    for (const [i, c] of clients.entries()) {
      const first = c.messages.slice(0, from[i]).reverse().find((m): m is Extract<RoomServerMessage, { type: 'room' }> => m.type === 'room');
      await c.waitFor((m) => m.type === 'room' && m.status === 'collecting' && (m.day !== first?.day || m.phase !== first?.phase || m.turn !== first?.turn), from[i]!);
    }
    await pause(150);
  }
  async function table() {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    const npc = getGameScenario(server.orm, gameId)!.npcs.find((n) => n.name.trim().length > 0 && n.name !== n.alias && !n.alias.includes(n.name))!;
    expect(npc).toBeDefined();
    return { t, npc, clients: [await enter(t.a), await enter(t.b), await enter(t.c)] };
  }
  const playerEntries = (c: RoomClient): RoomEntry[] => c.entries().filter((e) => e.kind === 'player');

  it('C1 + C2 + C4: B reads the alias of C and of the NPC; the Human GM view reads the text as typed', async () => {
    const { npc, clients } = await table();
    const typed = `ชี้ไปที่ ${MEKHA.name} และ ${npc.name} ด้วยกัน`;
    await playTurn(clients, [typed, 'ดื่มชา', 'อ่านประกาศ']);

    const forB = playerEntries(clients[1]!).find((e) => e.text.startsWith('ชี้ไปที่'));
    expect(forB?.text).toBe(`ชี้ไปที่ ${socialTitle(0)} และ ${npc.alias} ด้วยกัน`);
    expect(JSON.stringify(playerEntries(clients[1]!))).not.toContain(MEKHA.name);
    expect(JSON.stringify(playerEntries(clients[1]!))).not.toContain(npc.name);
    // C reads their own name as typed.
    expect(playerEntries(clients[2]!).find((e) => e.text.startsWith('ชี้ไปที่'))?.text).toContain(MEKHA.name);

    const row = server!.orm.select().from(roomEntry).where(eq(roomEntry.kind, 'player')).all().find((r) => r.text === typed)!;
    expect(row).toBeDefined();
    expect(entryViewOf(server!.orm, row, { id: 'gm', role: 'gm' }, server!.assets).text).toBe(typed);
  });

  it('C3: B introducing themself still shows their name to C', async () => {
    const { clients } = await table();
    const typed = `ข้าคือ ${DARIN.name} ยินดีที่ได้รู้จัก`;
    await playTurn(clients, ['ดื่มชา', typed, 'อ่านประกาศ']);
    expect(playerEntries(clients[2]!).find((e) => e.text.startsWith('ข้าคือ'))?.text).toBe(typed);
  });
});
