import { CharacterResponse, GameLogResponse, InventoryResponse, type RoomEntry } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transferItem } from '../src/crossplayer/items.ts';
import { character } from '../src/db/schema.ts';
import type { PhaseResolver } from '../src/room/resolver.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

type Bar = { hp: number; stamina: number; coins: number; conduct: string; items: string[]; active: string[] };
const ITEM = 'Prism of Truth'; // an Active item of the sheet (Rank B, 3 uses a day)

/**
 * GEN-125: A uses an Active item and the turn changes what the status bar shows (Stamina, the item, the karma word).
 * The resolver is scripted with the same shape the AI resolver returns (results + apply), no rule is changed.
 */
describe('GEN-125 [ใช้] an Active item: the log under the turn result equals the status bar', { timeout: 60_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  let karmaAfter: number | undefined;

  beforeEach(() => {
    karmaAfter = undefined;
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function play(): Promise<{ t: Table; a: RoomClient; before: Bar; after: Bar; entries: RoomEntry[]; logged: RoomEntry[] }> {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    let t!: Table;
    const resolver: PhaseResolver = {
      async resolve(input) {
        const stamina = input.state.players[t.a.memberId]!.stamina - 2;
        const item = [...server!.db.prepare('select reward from npc_reward where member_id = ?').all(t.a.memberId) as { reward: string }[]].length;
        return {
          results: { [t.a.memberId]: { stamina, ...(karmaAfter !== undefined ? { karma: karmaAfter } : {}) } },
          // the item is spent: it leaves A's hands (item_holder), as a steal / gift does; karma is written like crossplayer/phase.ts does
          apply: (tx) => {
            if (karmaAfter !== undefined) tx.update(character).set({ karma: karmaAfter }).where(eq(character.memberId, t.a.memberId)).run();
            if (item > 0) transferItem(tx, input.gameId, `reward:${t.a.memberId}:test:${ITEM}`, t.b.memberId, Date.now());
          },
        };
      },
    };
    server = await startTestServer(tmp.dir, { phaseResolver: resolver });
    t = await startedTable(server, false);
    server.db.prepare('insert into npc_reward (member_id, npc_id, reward, kind, granted_at) values (?, ?, ?, ?, 0)').run(t.a.memberId, 'test', ITEM, 'item');
    const bar = async (seat: Seat): Promise<Bar> => {
      const c = CharacterResponse.parse((await t.call('GET', '/api/game/character', { token: seat.token })).body).character!;
      const inv = InventoryResponse.parse((await t.call('GET', '/api/game/inventory', { token: seat.token })).body).inventory;
      return { hp: c.hp.current, stamina: c.stamina.current, coins: c.coins, conduct: c.conduct, items: inv.items.map((i) => i.name), active: inv.items.filter((i) => /active/i.test(i.triggerType ?? '')).map((i) => i.name) };
    };
    const before = await bar(t.a);
    const open = async (seat: Seat) => {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      return c;
    };
    const [a, b, c] = [await open(t.a), await open(t.b), await open(t.c)];
    for (const [client, text] of [[a, `ใช้ ${ITEM}`], [b, 'มองรอบๆ'], [c, 'นั่งพัก']] as const) {
      const from = client.messages.length;
      client.action(text, 'public');
      await client.waitFor((m) => m.type === 'action_accepted', from);
    }
    await a.waitFor((m) => m.type === 'room' && m.turn === 2 && m.status === 'collecting');
    await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'changes');
    const after = await bar(t.a);
    const entries = a.entries().filter((e) => e.kind === 'changes');
    const logged = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.a.token })).body).entries.filter((e) => e.kind === 'changes');
    return { t, a, before, after, entries, logged };
  }

  it('C1: the Active item is usable, then the log shows the lost item and values equal to the status bar', async () => {
    const r = await play();
    expect(r.before.active).toContain(ITEM);
    const changes = r.entries.flatMap((e) => e.changes ?? []);
    expect(changes).toContainEqual({ stat: 'item_lost', name: ITEM, reason: expect.any(String) });
    const sum = (stat: string) => changes.reduce((n, c) => n + (c.stat === stat && 'delta' in c ? c.delta : 0), 0);
    expect([sum('hp'), sum('stamina'), sum('coins')]).toEqual([r.after.hp - r.before.hp, r.after.stamina - r.before.stamina, r.after.coins - r.before.coins]);
    expect(r.after.stamina - r.before.stamina).toBe(-2);
    expect(r.after.items).not.toContain(ITEM);
    expect(r.before.items.filter((i) => !r.after.items.includes(i))).toEqual(changes.flatMap((c) => (c.stat === 'item_lost' ? [c.name] : [])));
  });

  it('C2: the karma word changing is logged as "old → new" with no number', async () => {
    karmaAfter = 30;
    const r = await play();
    expect(r.after.conduct).not.toBe(r.before.conduct);
    const conduct = r.entries.flatMap((e) => e.changes ?? []).filter((c) => c.stat === 'conduct');
    expect(conduct).toEqual([{ stat: 'conduct', from: r.before.conduct, to: r.after.conduct, reason: expect.any(String) }]);
    expect(JSON.stringify(conduct)).not.toMatch(/\d/);
  });

  it('C3: [ประวัติ] (GET /api/game/log) returns the same entries as the room', async () => {
    karmaAfter = 30;
    const r = await play();
    expect(r.logged).toEqual(r.entries);
    expect(r.logged.length).toBeGreaterThan(0);
  });
});
