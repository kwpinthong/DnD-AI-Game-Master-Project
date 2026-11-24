import { socialTitle } from '@isekai/rules';
import { RoomEntry, type RoomServerMessage } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../src/server.ts';
import { learnName } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { caller, CLOCK, LIN, startedTable, startTestServer } from './visibility-fixture.ts';

/**
 * GEN-129: another player's PUBLIC action reaches the viewers at the place as a `player` entry (actor name as the
 * viewer may know it + the action text), drawn as the PlayerBubble. A Secret action never does; the actor never
 * gets it back as "someone else".
 */
describe('GEN-129 player action entries', { timeout: 60_000 }, () => {
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
  async function playTurn(clients: RoomClient[], texts: string[], visibility: ('public' | 'secret')[] = []) {
    const from = clients.map((c) => c.messages.length);
    for (const [i, c] of clients.entries()) {
      c.action(texts[i]!, visibility[i] ?? 'public');
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
    return { t, clients: [await enter(t.a), await enter(t.b), await enter(t.c)] };
  }
  const players = (c: RoomClient): RoomEntry[] => c.entries().filter((e) => e.kind === 'player');

  it('C1 + C3: B who knows A reads the name, C who does not reads the alias and never the real name', async () => {
    const { t, clients } = await table();
    learnName(server!.orm, t.b.memberId, t.a.memberId, 'introduced', CLOCK);
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);

    const forB = players(clients[1]!).find((e) => e.text === 'เช็ดโต๊ะ');
    expect(RoomEntry.safeParse(forB).success).toBe(true);
    // ISK-007: everyone sees the preset avatar, known or not
    expect(forB?.actor).toEqual({ name: LIN.name, avatarId: 'avatar-01' });
    expect(forB?.place).not.toBeNull();
    const forC = players(clients[2]!).find((e) => e.text === 'เช็ดโต๊ะ');
    expect(forC?.actor).toEqual({ name: socialTitle(0), avatarId: 'avatar-01' });
    expect(JSON.stringify(clients[2]!.entries())).not.toContain(LIN.name);
    // Not votable: a player wrote it, not the AI.
    expect(forB && 'myVote' in forB).toBe(false);
  });

  it('C2: an undiscovered Secret action gives no entry to the others', async () => {
    const { clients } = await table();
    await playTurn(clients, ['ล้วงกระเป๋าลับ', 'ดื่มชา', 'อ่านประกาศ'], ['secret']);
    for (const c of [clients[1]!, clients[2]!]) expect(c.entries().some((e) => e.text.includes('ล้วงกระเป๋าลับ') && e.kind !== 'narration')).toBe(false);
    expect(players(clients[1]!).some((e) => e.text === 'ดื่มชา' || e.text === 'อ่านประกาศ')).toBe(true);
  });

  it('C7: the actor does not get their own action as another player', async () => {
    const { clients } = await table();
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);
    expect(players(clients[0]!).some((e) => e.text === 'เช็ดโต๊ะ')).toBe(false);
    expect(players(clients[0]!).some((e) => e.text === 'ดื่มชา')).toBe(true);
  });

  it('C6: reconnecting and GET /api/game/log give the same entries once, no duplicates', async () => {
    const { t, clients } = await table();
    await playTurn(clients, ['เช็ดโต๊ะ', 'ดื่มชา', 'อ่านประกาศ']);
    const live = players(clients[1]!).map((e) => e.seq);
    expect(live.length).toBeGreaterThan(0);
    const again = await enter(t.b);
    expect(players(again).map((e) => e.seq)).toEqual(live);
    const log = await caller(server!)('GET', '/api/game/log', { token: t.b.token });
    const fromLog = (log.body as { entries: RoomEntry[] }).entries.filter((e) => e.kind === 'player');
    expect(fromLog.map((e) => e.seq)).toEqual(live);
    expect(new Set(live).size).toBe(live.length);
  });
});
