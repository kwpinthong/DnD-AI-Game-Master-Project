import type { RoomServerMessage, RoomState } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClosedPhase, PhaseResolver } from '../src/room/resolver.ts';
import type { RunningServer } from '../src/server.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isEntry, isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-119 C1 + C3 over the real room: an exhausted player cannot send (the server refuses with the lock code), and a
 * socket cut while the turn is being resolved reconnects to the latest state with every entry exactly once.
 * (The unconscious and Astral Spirit refusals are in crisis.test.ts, GEN-070.)
 */
describe('GEN-119 locks and a cut socket on the real room', { timeout: 60_000 }, () => {
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  let release = () => {};
  let gate: Promise<void> | null = null;
  const calls: ClosedPhase[] = [];

  afterEach(async () => {
    release();
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });
  beforeEach(() => {
    calls.length = 0;
    gate = null;
  });

  const turnIs = (turn: number, phase = 'EOSORIA') => (m: RoomServerMessage): m is RoomState =>
    m.type === 'room' && m.status === 'collecting' && m.phase === phase && m.turn === turn;

  it('C1 + C3: Stamina 0 locks sending; a cut during resolving comes back to the latest state, no duplicate or missing entry', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    let t!: Table;
    const resolver: PhaseResolver = {
      async resolve(input) {
        calls.push(input);
        if (input.at.turn === 1 && input.at.phase === 'EOSORIA') {
          if (gate) await gate;
          return {
            results: { [t.a.memberId]: { stamina: 0 } },
            entries: [
              { kind: 'feed', locationId: 'fountain', actorMemberId: t.b.memberId, text: 'ฟีดเทิร์น 1' },
              { kind: 'narration', memberId: t.a.memberId, text: 'เล่าให้ A เทิร์น 1' },
            ],
          };
        }
        return {};
      },
    };
    server = await startTestServer(tmp.dir, { phaseResolver: resolver });
    t = await startedTable(server, false);
    for (const who of [t.a, t.b, t.c]) expect(moveCharacter(server.orm, who.memberId, 'fountain', CLOCK)).toBe(true);
    const open = async (seat: Seat, afterSeq = 0) => {
      const c = await openRoom(server!, { token: seat.token, afterSeq });
      sockets.push(c);
      await c.waitFor(isReady);
      return c;
    };
    const send = async (c: RoomClient) => {
      const from = c.messages.length;
      c.action('เดินดูรอบๆ', 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    };
    let a = await open(t.a);
    const [b, c] = [await open(t.b), await open(t.c)];
    gate = new Promise<void>((r) => (release = r));
    await send(a);
    await send(b);
    await send(c);
    await a.waitFor((m) => m.type === 'room' && m.status === 'resolving');
    // The socket is cut while the turn is being resolved; the turn finishes without A's socket.
    await a.close();
    release();
    await b.waitFor(turnIs(2));
    expect(calls).toHaveLength(1);

    a = await open(t.a, 0);
    const room = a.lastRoom()!;
    expect(room).toMatchObject({ turn: 2, status: 'collecting' });
    expect(room.you.lock?.code).toBe('exhausted');
    const entries = a.entries();
    // feed + narration + the player's own change log (GEN-114: Stamina to 0) + one `player` entry per
    // other player's public action at the place (GEN-129: B and C acted here)
    // ISK-014: + day 1's morning news.
    expect(entries.map((e) => e.kind).sort()).toEqual(['changes', 'feed', 'narration', 'news', 'player', 'player']);
    expect(entries.find((e) => e.kind === 'changes')!.changes).toContainEqual(expect.objectContaining({ stat: 'stamina' }));
    expect(new Set(entries.map((e) => e.seq)).size).toBe(entries.length);
    expect(a.messages.filter(isEntry).length).toBe(entries.length);

    // C1: sending is refused with the lock code, in words.
    const from = a.messages.length;
    a.action('ลุกขึ้นสู้', 'public');
    const refused = await a.waitFor((m) => m.type === 'action_rejected', from);
    expect(refused).toMatchObject({ code: 'exhausted' });
    expect((refused as { message: string }).message).toMatch(/หมดแรง/);

    // A second reconnect from the last seen entry gets nothing again (no duplicate).
    const again = await open(t.a, Math.max(...entries.map((e) => e.seq)));
    expect(again.entries()).toEqual([]);
  });
});
