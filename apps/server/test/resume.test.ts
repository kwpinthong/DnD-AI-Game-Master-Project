import type { RoomEntry, RoomState } from '@isekai/protocol';
import { SeededRng, phaseStep, turnNumber, type PhaseState, type TurnPoint } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { makeTempDir } from './helpers.ts';
import type { RoomClient } from './room-client.ts';
import { atTurn, dumpTables, enterRoom, fourPlayerTable, playFirstTurn, sendAction, type FourTable } from './resume-fixture.ts';
import { CLOCK, startTestServer } from './visibility-fixture.ts';

/**
 * GEN-037 C1 + C2 over the real WebSocket room and the AI GM turn loop (Mock provider): a restart puts
 * the game exactly where it was. Nothing of the game lives only in memory.
 */

/** Plays the engine forward to `to` (everyone acts; in NOCTHERION everyone sleeps). */
function advance(state: PhaseState, to: TurnPoint): PhaseState {
  let s = state;
  for (let guard = 0; guard < 200 && turnNumber(s) < turnNumber(to); guard++) {
    if (s.status === 'collecting') {
      for (const id of s.order) {
        if (s.submissions[id]) continue;
        const action = { text: 'เดินเล่น', visibility: 'public' as const, rest: s.phase === 'NOCTHERION' };
        const r = phaseStep(s, { type: 'submit', playerId: id, action }, new SeededRng(1));
        if (!r.ok) throw new Error(r.error.code);
        s = r.state;
      }
    }
    const r = phaseStep(s, { type: 'resolved', results: {} }, new SeededRng(1));
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
  }
  return s;
}

describe('resume after a restart (GEN-037)', { timeout: 120_000 }, () => {
  let dir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir, cleanup } = makeTempDir());
    server = await startTestServer(dir);
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function closeSockets() {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
  }

  async function restart() {
    await closeSockets();
    await server!.close();
    server = await startTestServer(dir);
  }

  /** What each seat gets when it enters with nothing (afterSeq 0): its whole feed + narration + whispers. */
  async function replayOf(t: FourTable): Promise<RoomEntry[][]> {
    const out: RoomEntry[][] = [];
    for (const seat of t.seats) {
      const client = await enterRoom(server!, seat, sockets);
      out.push(client.entries());
    }
    await closeSockets();
    return out;
  }

  function jumpTo(t: FourTable, to: TurnPoint) {
    savePhaseState(server!.orm, t.gameId, advance(ensurePhaseState(server!.orm, t.gameId, CLOCK), to), CLOCK);
  }

  it('C1: day 5 SOLARION with 2 of 4 sent: after a restart the same turn, the same 2 sent, nobody sends again', async () => {
    const t = await fourPlayerTable(server!);
    await playFirstTurn(server!, t, sockets);
    await closeSockets();
    jumpTo(t, { day: 5, phase: 'SOLARION', turn: 1 });

    const [a, b] = [await enterRoom(server!, t.seats[0], sockets), await enterRoom(server!, t.seats[1], sockets)];
    expect(a.lastRoom()).toMatchObject({ day: 5, phase: 'SOLARION', turn: 1, status: 'collecting' });
    expect(await sendAction(a, 'แอบตามพ่อค้าไปหลังตลาด', 'secret')).toEqual({ type: 'action_accepted' });
    expect(await sendAction(b, 'ซ่อมรั้วให้ยาย')).toEqual({ type: 'action_accepted' });
    await a.waitFor((m) => m.type === 'room' && m.submittedCount === 2);
    const roomBefore = a.lastRoom()!;

    await closeSockets();
    const tablesBefore = dumpTables(server!.db);
    await restart();
    // Everything the game is made of came back from SQLite as it was: every row of every table.
    expect(dumpTables(server!.db)).toEqual(tablesBefore);

    const rooms: RoomState[] = [];
    const clients: RoomClient[] = [];
    for (const seat of t.seats) {
      const client = await enterRoom(server!, seat, sockets);
      clients.push(client);
      rooms.push(client.lastRoom()!);
    }
    for (const room of rooms) expect(room).toMatchObject({ day: 5, phase: 'SOLARION', turn: 1, status: 'collecting', gmStatus: null });
    // Q-195: each player sees the count and their own flag.
    for (const room of rooms) expect(room.submittedCount).toBe(2);
    rooms.forEach((room, i) => expect(room.members.find((m) => m.memberId === t.seats[i]!.memberId)!.submitted).toBe(i < 2));
    expect(rooms[0]!.you.action).toEqual({ text: 'แอบตามพ่อค้าไปหลังตลาด', visibility: 'secret', rest: false });
    expect(rooms[0]!.you.secretUsed).toBe(roomBefore.you.secretUsed);
    expect(rooms[1]!.you.action).toEqual({ text: 'ซ่อมรั้วให้ยาย', visibility: 'public', rest: false });
    expect([rooms[2]!.you.action, rooms[3]!.you.action]).toEqual([null, null]);
    expect(rooms[0]!.you.lock).toBeNull();

    // C and D send; the turn closes with all four, A and B never sent again.
    expect(await sendAction(clients[2]!, 'เฝ้าประตูเมือง')).toEqual({ type: 'action_accepted' });
    expect(await sendAction(clients[3]!, 'ร้องเพลงที่ลานวัด')).toEqual({ type: 'action_accepted' });
    for (const client of clients) await client.waitFor(atTurn(5, 'SOLARION', 2));
    const actions = server!.db
      .prepare("select member_id as memberId, text from phase_action where day = 5 and phase = 'SOLARION' and turn = 1 order by member_id")
      .all();
    expect(actions).toHaveLength(4);
    expect(actions).toContainEqual({ memberId: t.seats[0].memberId, text: 'แอบตามพ่อค้าไปหลังตลาด' });
    expect(actions).toContainEqual({ memberId: t.seats[1].memberId, text: 'ซ่อมรั้วให้ยาย' });
  });

  it('C2: after a restart every player gets their own feed and private narration back, complete and only theirs', async () => {
    const t = await fourPlayerTable(server!);
    await playFirstTurn(server!, t, sockets);
    await closeSockets();

    const before = await replayOf(t);
    // The played turn gave every player something, and each one a narration of their own.
    for (const entries of before) {
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.kind === 'narration')).toBe(true);
    }
    const narrations = before.map((entries) => entries.filter((e) => e.kind === 'narration').map((e) => e.seq));
    for (const [i, mine] of narrations.entries()) {
      for (const [j, theirs] of narrations.entries()) if (i !== j) expect(mine.filter((seq) => theirs.includes(seq))).toEqual([]);
    }

    await restart();
    const after = await replayOf(t);
    expect(after).toEqual(before);

    // A tab that already has everything asks after its last seq and gets nothing twice.
    for (const [i, seat] of t.seats.entries()) {
      const lastSeq = before[i]!.at(-1)!.seq;
      const client = await enterRoom(server!, seat, sockets, lastSeq);
      expect(client.entries()).toEqual([]);
      expect(client.messages.find((m) => m.type === 'ready')).toEqual({ type: 'ready', lastSeq });
    }
  });
});
