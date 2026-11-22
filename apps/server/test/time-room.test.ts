import type { RoomServerMessage } from '@isekai/protocol';
import { SeededRng, phaseStep, turnNumber, type PhaseState, type TurnPoint } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClosedPhase, PhaseResolution, PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

/** GEN-063 over the real WebSocket room: period + turn, the free NOCTHERION Secret, Drowsy, and a restart mid-turn. */

function scriptedResolver() {
  const calls: ClosedPhase[] = [];
  let respond: (input: ClosedPhase) => PhaseResolution = () => ({});
  const resolver: PhaseResolver = {
    async resolve(input) {
      calls.push(input);
      return respond(input);
    },
  };
  return {
    resolver,
    calls,
    respond(f: (input: ClosedPhase) => PhaseResolution) {
      respond = f;
    },
  };
}

/** Plays the engine forward to `to` (everyone acts; in NOCTHERION everyone sleeps), as if the turns were played. */
function advance(state: PhaseState, to: TurnPoint): PhaseState {
  let s = state;
  for (let guard = 0; guard < 200 && turnNumber(s) < turnNumber(to); guard++) {
    for (const id of s.order) {
      const action = { text: 'เดินเล่น', visibility: 'public' as const, rest: s.phase === 'NOCTHERION' };
      const r = phaseStep(s, { type: 'submit', playerId: id, action }, new SeededRng(1));
      if (!r.ok) throw new Error(r.error.code);
      s = r.state;
    }
    const r = phaseStep(s, { type: 'resolved', results: {} }, new SeededRng(1));
    if (!r.ok) throw new Error(r.error.code);
    s = r.state;
  }
  return s;
}

describe('GEN-063 time system in the play room', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let script: ReturnType<typeof scriptedResolver>;
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    script = scriptedResolver();
    server = await startTestServer(dataDir, { phaseResolver: script.resolver });
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function send(client: RoomClient, text: string, visibility: 'public' | 'secret' = 'public', rest?: boolean) {
    const from = client.messages.length;
    client.action(text, visibility, rest);
    return client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
  }

  const at = (day: number, phase: string, turn: number) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';

  /** Moves the stored game to `to` before anyone is in the room. */
  function jumpTo(t: Table, to: TurnPoint, edit: (s: PhaseState) => PhaseState = (s) => s): void {
    const gameId = server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string };
    const state = edit(advance(ensurePhaseState(server!.orm, gameId.id, CLOCK), to));
    savePhaseState(server!.orm, gameId.id, state, CLOCK);
  }

  it('C1: the room counts turns: EOSORIA turn 1 -> turn 2 -> SOLARION turn 1', async () => {
    const t = await startedTable(server!, false);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    expect(a.lastRoom()).toMatchObject({ day: 1, phase: 'EOSORIA', turn: 1 });
    for (const round of [1, 2]) {
      for (const client of [a, b, c]) expect(await send(client, `รอบ ${round}`)).toEqual({ type: 'action_accepted' });
      await a.waitFor(round === 1 ? at(1, 'EOSORIA', 2) : at(1, 'SOLARION', 1));
    }
    expect(script.calls.map((x) => x.at)).toEqual([
      { day: 1, phase: 'EOSORIA', turn: 1 },
      { day: 1, phase: 'EOSORIA', turn: 2 },
    ]);
    expect(server!.db.prepare('select distinct day, phase, turn from phase_action order by turn').all()).toEqual([
      { day: 1, phase: 'EOSORIA', turn: 1 },
      { day: 1, phase: 'EOSORIA', turn: 2 },
    ]);
  });

  it('C3 + C4: a free Secret in NOCTHERION, refused the second time; staying awake = Drowsy next day', async () => {
    const t = await startedTable(server!, false);
    // A already used today's Secret earlier on day 1.
    jumpTo(t, { day: 1, phase: 'NOCTHERION', turn: 1 }, (s) => ({
      ...s,
      players: { ...s.players, [t.a.memberId]: { ...s.players[t.a.memberId]!, secretDay: 1 } },
    }));
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    expect(a.lastRoom()!.you).toMatchObject({ secretUsed: false, drowsy: false });

    expect(await send(a, 'แอบตามคนคลุมแดง', 'secret')).toEqual({ type: 'action_accepted' });
    expect(await send(b, 'นอนพัก', 'public', true)).toEqual({ type: 'action_accepted' });
    expect(await send(c, 'นอนพัก', 'public', true)).toEqual({ type: 'action_accepted' });
    await a.waitFor(at(1, 'NOCTHERION', 2));
    expect(script.calls[0]!.actions.map((x) => x.rest)).toEqual([false, true, true]);
    expect(a.lastRoom()!.you.secretUsed).toBe(true);

    const refused = await send(a, 'แอบอีกรอบ', 'secret');
    expect(refused).toMatchObject({ type: 'action_rejected', code: 'secret_quota_used' });
    if (refused.type !== 'action_rejected') throw new Error('expected a refusal');
    expect(refused.message).toContain('NOCTHERION');
    expect(refused.message).toMatch(/[ก-๙]/);

    expect(await send(a, 'เฝ้ายามทั้งคืน')).toEqual({ type: 'action_accepted' });
    expect(await send(b, 'เฝ้ายาม')).toEqual({ type: 'action_accepted' });
    expect(await send(c, 'นอนต่อ', 'public', true)).toEqual({ type: 'action_accepted' });
    await a.waitFor(at(2, 'EOSORIA', 1));
    await b.waitFor(at(2, 'EOSORIA', 1));
    expect(a.lastRoom()!.you.drowsy).toBe(true);
    expect(b.lastRoom()!.you.drowsy).toBe(false);
    expect(a.lastRoom()!.you.secretUsed).toBe(false);

    // Drowsy +1 Stamina: the resolver settles 25 for both; A (Drowsy) ends on 24.
    script.respond(() => ({ results: { [t.a.memberId]: { stamina: 25 }, [t.b.memberId]: { stamina: 25 } } }));
    for (const client of [a, b, c]) expect(await send(client, 'ทำงานที่ตลาด')).toEqual({ type: 'action_accepted' });
    await a.waitFor(at(2, 'EOSORIA', 2));
    const stamina = (id: string) => (server!.db.prepare('select stamina from character where member_id = ?').get(id) as { stamina: number }).stamina;
    expect(stamina(t.a.memberId)).toBe(24);
    expect(stamina(t.b.memberId)).toBe(25);
    for (const client of [a, b, c]) for (const m of client.messages) expect(forbiddenKeysIn(m)).toEqual([]);
  });

  it('C5: the character karma decides the Evil make-up sleep (Q-087): karma -20 rests in EOSORIA, karma 0 stays Drowsy', async () => {
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 1, phase: 'NOCTHERION', turn: 1 });
    // Karma written by the cross-player rules after the engine state was made.
    server!.db.prepare('update character set karma = -20 where member_id = ?').run(t.a.memberId);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const turn of [1, 2]) {
      expect(await send(a, 'เฝ้ายาม')).toEqual({ type: 'action_accepted' });
      expect(await send(b, 'เฝ้ายาม')).toEqual({ type: 'action_accepted' });
      expect(await send(c, 'นอน', 'public', true)).toEqual({ type: 'action_accepted' });
      await a.waitFor(turn === 1 ? at(1, 'NOCTHERION', 2) : at(2, 'EOSORIA', 1));
    }
    await b.waitFor(at(2, 'EOSORIA', 1));
    expect([a.lastRoom()!.you.drowsy, b.lastRoom()!.you.drowsy]).toEqual([true, true]);
    for (const client of [a, b]) expect(await send(client, 'งีบชดเชย', 'public', true)).toEqual({ type: 'action_accepted' });
    expect(await send(c, 'เดินตลาด')).toEqual({ type: 'action_accepted' });
    await a.waitFor(at(2, 'EOSORIA', 2));
    await b.waitFor(at(2, 'EOSORIA', 2));
    expect([a.lastRoom()!.you.drowsy, b.lastRoom()!.you.drowsy]).toEqual([false, true]);
  });

  it('C7: a restart at day 5 SOLARION turn 2 with 2 of 3 sent: same place, nobody sends again', async () => {
    const t = await startedTable(server!, false);
    jumpTo(t, { day: 5, phase: 'SOLARION', turn: 2 });
    let [a, b] = [await enter(t.a), await enter(t.b)];
    expect(a.lastRoom()).toMatchObject({ day: 5, phase: 'SOLARION', turn: 2, status: 'collecting' });
    expect(await send(a, 'ซ่อนตัวหลังร้านขนมปัง')).toEqual({ type: 'action_accepted' });
    expect(await send(b, 'ถามข่าวพ่อค้า')).toEqual({ type: 'action_accepted' });
    expect(script.calls).toEqual([]);

    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server!.close();
    server = await startTestServer(dataDir, { phaseResolver: script.resolver });

    [a, b] = [await enter(t.a), await enter(t.b)];
    const c = await enter(t.c);
    const room = c.lastRoom()!;
    expect(room).toMatchObject({ day: 5, phase: 'SOLARION', turn: 2, status: 'collecting' });
    // Q-195: C sees that 2 sent, and that C did not.
    expect(room.submittedCount).toBe(2);
    expect(room.members.find((m) => m.memberId === t.c.memberId)!.submitted).toBe(false);
    expect(a.lastRoom()!.members.find((m) => m.memberId === t.a.memberId)!.submitted).toBe(true);
    expect(a.lastRoom()!.you.action).toEqual({ text: 'ซ่อนตัวหลังร้านขนมปัง', visibility: 'public', rest: false });
    expect(a.lastRoom()!.you.lock).toBeNull();

    // C's action closes the turn with all three actions; nobody re-sent.
    expect(await send(c, 'เดินตรวจกำแพง')).toEqual({ type: 'action_accepted' });
    await c.waitFor(at(5, 'HESPERION', 1));
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]!.at).toEqual({ day: 5, phase: 'SOLARION', turn: 2 });
    expect(script.calls[0]!.actions.map((x) => x.text)).toEqual(['ซ่อนตัวหลังร้านขนมปัง', 'ถามข่าวพ่อค้า', 'เดินตรวจกำแพง']);
  });

  it('REST can be sent in any turn and comes back as your action; a non-boolean rest is a bad message', async () => {
    const t = await startedTable(server!, false);
    const a = await enter(t.a);
    expect(await send(a, 'งีบใต้ต้นไม้', 'public', true)).toEqual({ type: 'action_accepted' });
    await a.waitFor((m) => m.type === 'room' && m.you.action?.rest === true);
    expect(a.lastRoom()!.you.action).toEqual({ text: 'งีบใต้ต้นไม้', visibility: 'public', rest: true });
    const from = a.messages.length;
    a.send({ type: 'action', text: 'x', visibility: 'public', rest: 'yes' });
    expect(await a.waitFor((m) => m.type === 'error', from)).toMatchObject({ code: 'bad_message' });
  });
});
