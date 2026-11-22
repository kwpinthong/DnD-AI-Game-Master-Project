import type { RoomServerMessage } from '@isekai/protocol';
import type { PhaseState, ResolutionInput, Rng } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { character } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
import type { ClosedPhase, PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { npcsMetBy, travel } from '../src/travel/service.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Table } from './visibility-fixture.ts';

const FOUNTAIN = 'น้ำพุกลางเมือง';
const CHURCH = 'โบสถ์';
const FOREST = 'ป่า';
const SEA = 'ทะเล';
const MANOR = 'เคหาสน์เจ้าเมือง';
const BARRACKS = 'ค่ายทหารป้องกันเมือง';
const LIBRARY = 'หอสมุดหลวง';
const RIFT = 'มิติพิศวง (The Astral Rift)';
/**
 * The default scenario (GEN-071) has every Location under its own id, so a move there stores and returns
 * the scenario's id (service.ts `storedId`). Places put with `put` keep the Location name.
 */
const SCENARIO_ID = { church: 'temple', forest: 'forest', manor: 'manor', barracks: 'barracks', rift: 'astral-rift' } as const;

/** Always rolls `face`. */
const fixedRng = (face: number): Rng => ({ nextInt: (min, max) => Math.max(min, Math.min(max, face)) });

describe('GEN-066 travel in the play room', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  let calls: ClosedPhase[] = [];
  const sockets: RoomClient[] = [];

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = makeTempDir());
    calls = [];
    const resolver: PhaseResolver = {
      async resolve(input) {
        calls.push(input);
        return {};
      },
    };
    server = await startTestServer(dataDir, { phaseResolver: resolver });
  });

  afterEach(async () => {
    for (const s of sockets) for (const m of s.messages) expect(forbiddenKeysIn(m)).toEqual([]);
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

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const state = (t: Table) => ensurePhaseState(server!.orm, gameIdOf(t), CLOCK);
  const staminaOf = (t: Table, memberId: string) => state(t).players[memberId]!.stamina;
  const placeOf = (memberId: string) => presenceOf(server!.orm, memberId)?.locationId;
  const put = (memberId: string, locationId: string) => expect(moveCharacter(server!.orm, memberId, locationId, CLOCK)).toBe(true);
  /** Edits the stored engine state before anyone is in the room. */
  const editState = (t: Table, edit: (s: PhaseState) => PhaseState) => savePhaseState(server!.orm, gameIdOf(t), edit(state(t)), CLOCK);
  const setKarma = (memberId: string, karma: number) =>
    server!.orm.update(character).set({ karma }).where(eq(character.memberId, memberId)).run();

  async function move(client: RoomClient, to: string) {
    const from = client.messages.length;
    client.send({ type: 'move', to });
    return client.waitFor((m) => m.type === 'move_accepted' || m.type === 'move_rejected', from);
  }

  async function act(client: RoomClient, text: string) {
    const from = client.messages.length;
    client.action(text, 'public');
    return client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
  }

  const turnIs = (day: number, phase: string, turn: number) => (m: RoomServerMessage) =>
    m.type === 'room' && m.day === day && m.phase === phase && m.turn === turn && m.status === 'collecting';

  it('C1: fountain -> church (same zone): there now, Stamina -1, and the player still sends this turn an action', async () => {
    const t = await startedTable(server!, false);
    put(t.a.memberId, FOUNTAIN);
    const a = await enter(t.a);

    const before = a.messages.length;
    expect(await move(a, CHURCH)).toEqual({ type: 'move_accepted', kind: 'same_zone', place: { id: SCENARIO_ID.church, name: CHURCH }, arrives: 'now' });
    expect(placeOf(t.a.memberId)).toBe(SCENARIO_ID.church);
    expect(staminaOf(t, t.a.memberId)).toBe(29);
    await a.waitFor((m) => m.type === 'room' && m.you.place?.id === SCENARIO_ID.church, before);
    expect(await act(a, 'สวดภาวนาที่โบสถ์')).toEqual({ type: 'action_accepted' });
  });

  it('C2: fountain -> forest (another zone) is the whole turn, Stamina -3, and arrives when the turn closes; Stamina 2 is refused', async () => {
    const t = await startedTable(server!, false);
    put(t.a.memberId, FOUNTAIN);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];

    expect(await move(a, FOREST)).toEqual({ type: 'move_accepted', kind: 'cross_zone', place: { id: SCENARIO_ID.forest, name: FOREST }, arrives: 'next_turn' });
    expect(placeOf(t.a.memberId)).toBe(FOUNTAIN);
    expect(staminaOf(t, t.a.memberId)).toBe(27);
    expect(state(t).submissions[t.a.memberId]?.text).toContain(FOREST);
    // The trip is this turn's action: no other action, no second move.
    expect(await act(a, 'ซื้อขนมปัง')).toMatchObject({ type: 'action_rejected', code: 'traveling' });
    expect(await move(a, 'โรงเตี๊ยมและกิลด์นักเดินทาง')).toMatchObject({ type: 'move_rejected', code: 'traveling' });

    expect(await act(b, 'รอ')).toEqual({ type: 'action_accepted' });
    expect(await act(c, 'รอ')).toEqual({ type: 'action_accepted' });
    await a.waitFor(turnIs(1, 'EOSORIA', 2));
    expect(placeOf(t.a.memberId)).toBe(SCENARIO_ID.forest);
    expect(calls[0]!.actions.find((x) => x.memberId === t.a.memberId)).toMatchObject({ travelingTo: SCENARIO_ID.forest, locationId: FOUNTAIN });
    expect(calls[0]!.actions.find((x) => x.memberId === t.b.memberId)).toMatchObject({ travelingTo: null });
    // Next turn the player acts as usual.
    expect(await act(a, 'เก็บสมุนไพร')).toEqual({ type: 'action_accepted' });

    // Stamina 2: "แรงไม่พอ", nothing changes.
    put(t.b.memberId, FOUNTAIN);
    await a.close();
    await b.close();
    await c.close();
    editState(t, (s) => ({ ...s, submissions: {}, players: { ...s.players, [t.b.memberId]: { ...s.players[t.b.memberId]!, stamina: 2 } } }));
    const b2 = await enter(t.b);
    const refused = await move(b2, FOREST);
    expect(refused).toMatchObject({ type: 'move_rejected', code: 'not_enough_stamina' });
    expect(refused.type === 'move_rejected' ? refused.message : '').toContain('แรงไม่พอ');
    expect(placeOf(t.b.memberId)).toBe(FOUNTAIN);
    expect(staminaOf(t, t.b.memberId)).toBe(2);
  });

  it('C3: from day 5 a turn in the forest or at the sea costs Stamina 10; on day 4 it does not', async () => {
    const t = await startedTable(server!, false);
    put(t.a.memberId, FOREST);
    put(t.b.memberId, SEA);
    put(t.c.memberId, FOUNTAIN);

    editState(t, (s) => ({ ...s, day: 4 }));
    let clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const client of clients) expect(await act(client, 'สำรวจรอบ ๆ')).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor(turnIs(4, 'EOSORIA', 2));
    expect([t.a, t.b, t.c].map((s) => staminaOf(t, s.memberId))).toEqual([30, 30, 30]);
    await Promise.all(clients.map((x) => x.close()));

    editState(t, (s) => ({ ...s, day: 5, turn: 1 }));
    clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const client of clients) expect(await act(client, 'สำรวจรอบ ๆ')).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor(turnIs(5, 'EOSORIA', 2));
    expect([t.a, t.b, t.c].map((s) => staminaOf(t, s.memberId))).toEqual([20, 20, 30]);
    for (const client of clients) expect(await act(client, 'สำรวจต่อ')).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor(turnIs(5, 'SOLARION', 1));
    expect([t.a, t.b, t.c].map((s) => staminaOf(t, s.memberId))).toEqual([10, 10, 30]);
  });

  it('C4: walking into the manor without a right is refused; INFILTRATE rolls through the resolution engine; a soldier enters the barracks', async () => {
    const t = await startedTable(server!, false);
    put(t.a.memberId, FOUNTAIN);
    const a = await enter(t.a);
    expect(await move(a, MANOR)).toMatchObject({ type: 'move_rejected', code: 'restricted' });
    expect(await move(a, BARRACKS)).toMatchObject({ type: 'move_rejected', code: 'restricted' });
    expect(placeOf(t.a.memberId)).toBe(FOUNTAIN);
    expect(staminaOf(t, t.a.memberId)).toBe(30);
    await a.close();

    const gameId = gameIdOf(t);
    const infiltration = (memberId: string): ResolutionInput => ({
      state: {
        actor: {
          id: memberId,
          locationId: FOUNTAIN,
          hp: 100,
          stamina: 30,
          rep: 0,
          karma: 0,
          affinity: {},
          items: [],
          skills: [],
          statuses: [],
          afterActionStamina: 0,
          damageReduction: 0,
        },
        npcs: {},
      },
      proposal: {
        actionId: 'infiltrate-1',
        kind: 'general',
        tags: ['stealth'],
        opposed: false,
        staminaCost: 3,
        visibility: 'secret',
        target: null,
        check: { type: 'dc', dc: 14 },
        modifiers: [{ source: 'stat' }],
        witnessNpcIds: [],
        repDeltaIfCaught: 0,
        onSuccess: { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] },
        onFail: { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] },
        reason: 'INFILTRATE เคหาสน์เจ้าเมือง',
      },
    });

    // A failed roll: refused, still at the fountain; the attempt's Stamina is spent.
    const failed = travel(server!.orm, server!.assets, gameId, t.a.memberId, { to: MANOR, infiltrate: { input: infiltration(t.a.memberId), rng: fixedRng(2) } }, CLOCK);
    expect(failed).toMatchObject({ ok: false, code: 'infiltrate_failed' });
    expect(failed.infiltration?.degree).toBe('fail');
    expect(placeOf(t.a.memberId)).toBe(FOUNTAIN);
    expect(staminaOf(t, t.a.memberId)).toBe(27);

    // A success: the trip to the manor (another zone) is on.
    put(t.b.memberId, FOUNTAIN);
    const entered = travel(server!.orm, server!.assets, gameId, t.b.memberId, { to: MANOR, infiltrate: { input: infiltration(t.b.memberId), rng: fixedRng(18) } }, CLOCK);
    expect(entered).toMatchObject({ ok: true, kind: 'cross_zone', arrives: 'next_turn', place: { id: SCENARIO_ID.manor, name: MANOR } });
    expect(entered.infiltration?.degree).toBe('success');
    expect(staminaOf(t, t.b.memberId)).toBe(30 - 3 - 3);

    // The soldier's start scenario (GEN-065 input) walks into the barracks.
    put(t.c.memberId, 'ย่านการค้า-ตลาดมืด');
    const soldier = travel(server!.orm, server!.assets, gameId, t.c.memberId, { to: BARRACKS, startScenario: 'ทหารเกณฑ์ประจำป้อม' }, CLOCK);
    expect(soldier).toMatchObject({ ok: true, kind: 'same_zone', arrives: 'now', infiltration: null });
    expect(placeOf(t.c.memberId)).toBe(SCENARIO_ID.barracks);

    // The turn closes: B arrives at the manor.
    const clients = [await enter(t.a), await enter(t.c)];
    for (const client of clients) expect(await act(client, 'รอ')).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor(turnIs(1, 'EOSORIA', 2));
    expect(placeOf(t.b.memberId)).toBe(SCENARIO_ID.manor);
  });

  it('C6: from the library on a clear night with karma +10 the player spends one turn in the rift and comes back; karma +20 or rain is refused', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    editState(t, (s) => ({ ...s, phase: 'HESPERION' }));
    put(t.a.memberId, LIBRARY);
    put(t.b.memberId, LIBRARY);
    setKarma(t.a.memberId, 10);
    setKarma(t.b.memberId, 20);

    expect(travel(server!.orm, server!.assets, gameId, t.b.memberId, { to: RIFT, weather: 'Clear Night' }, CLOCK)).toMatchObject({ ok: false, code: 'rift_closed' });
    expect(travel(server!.orm, server!.assets, gameId, t.a.memberId, { to: RIFT, weather: 'Rain' }, CLOCK)).toMatchObject({ ok: false, code: 'rift_closed' });
    expect(placeOf(t.b.memberId)).toBe(LIBRARY);

    expect(travel(server!.orm, server!.assets, gameId, t.a.memberId, { to: RIFT, weather: 'Clear Night' }, CLOCK)).toMatchObject({
      ok: true,
      kind: 'rift',
      arrives: 'now',
    });
    expect(placeOf(t.a.memberId)).toBe(SCENARIO_ID.rift);
    expect(npcsMetBy(server!.orm, server!.assets, gameId, t.a.memberId)).toEqual(['แอสทรา']);

    const clients = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const client of clients) expect(await act(client, 'สำรวจ')).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor(turnIs(1, 'HESPERION', 2));
    expect(placeOf(t.a.memberId)).toBe(LIBRARY);
  });

  it('C7: a player at the fountain in SOLARION meets the NPC the schedule puts there; in another period not', async () => {
    const t = await startedTable(server!, false);
    const gameId = gameIdOf(t);
    put(t.a.memberId, FOUNTAIN);
    expect(npcsMetBy(server!.orm, server!.assets, gameId, t.a.memberId)).not.toContain('ลูเซีย');
    editState(t, (s) => ({ ...s, phase: 'SOLARION' }));
    expect(npcsMetBy(server!.orm, server!.assets, gameId, t.a.memberId)).toEqual(expect.arrayContaining(['ลูเซีย', 'โนอา']));
    // B starts at the default scenario's `inn`, read as the Location "โรงเตี๊ยมและกิลด์นักเดินทาง":
    // the schedule puts Garrett there in SOLARION only.
    expect(placeOf(t.b.memberId)).toBe('inn');
    expect(npcsMetBy(server!.orm, server!.assets, gameId, t.b.memberId)).toEqual(['จ่าสิบเอกการ์เร็ต']);
    editState(t, (s) => ({ ...s, phase: 'HESPERION' }));
    expect(npcsMetBy(server!.orm, server!.assets, gameId, t.b.memberId)).not.toContain('จ่าสิบเอกการ์เร็ต');
  });

  it('C8: a location id that does not exist is an error and the place does not change', async () => {
    const t = await startedTable(server!, false);
    const a = await enter(t.a);
    for (const to of ['ลานตลาด', 'market', '']) {
      const reply = await move(a, to);
      expect(reply, to).toMatchObject({ type: 'move_rejected', code: 'unknown_location' });
      expect(reply.type === 'move_rejected' ? reply.message : '').toMatch(/[ก-๙]/);
    }
    expect(placeOf(t.a.memberId)).toBe('inn');
    expect(staminaOf(t, t.a.memberId)).toBe(30);
    // The start place `inn` is the Central Zone's inn: the forest is another zone.
    expect(await move(a, FOREST)).toMatchObject({ type: 'move_accepted', kind: 'cross_zone', arrives: 'next_turn' });
  });
});
