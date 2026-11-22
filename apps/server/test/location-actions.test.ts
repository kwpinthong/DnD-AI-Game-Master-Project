import type { RoomServerMessage } from '@isekai/protocol';
import { ReplayRng, type PhaseAction, type PhaseState, type Rng } from '@isekai/rules';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import { applyPhaseActions } from '../src/crossplayer/phase.ts';
import { character } from '../src/db/schema.ts';
import type { PhaseResolver } from '../src/room/resolver.ts';
import { ensurePhaseState, savePhaseState } from '../src/room/store.ts';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-069 Location actions in the real play room (default scenario ids): REST at the inn costs 5 coins,
 * the infirmary heals, TRAIN at the guild raises Max HP, a Public action at the fountain moves Reputation
 * ×1.5. Q-209: the start scenario passives that are not d20 bonuses. Q-218: night rest by Rest_Quality.
 * The resolver gives no results, so every number here is the engine's and the server's.
 */
const assets = loadGameAssets();

/** Start_Scenarios rows (one nextInt(1, 10000) per player, rows 1-10 are 700 wide). */
const MUSICIAN = 1; // row 1 @ fountain
const DISHWASHER = 701; // row 2 @ inn: REST Stamina +2 at a TAVERN
const LABORER = 2801; // row 5 @ farmland: stamina_cost -1 OUTDOOR
const CASTAWAY = 4901; // row 8 @ sea: REST HP +3 at a COASTAL place
const PATIENT = 6301; // row 10 @ clinic: REST HP +5

class ScriptedRng implements Rng {
  private readonly values: number[];
  constructor(values: number[]) {
    this.values = [...values];
  }
  nextInt(min: number, max: number): number {
    const value = this.values.shift();
    if (value === undefined || value < min || value > max) throw new Error(`ScriptedRng: ${value} for ${min}..${max}`);
    return value;
  }
}

describe('GEN-069 location actions', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];
  const resolver: PhaseResolver = { resolve: async () => ({}) };

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    for (const s of sockets) for (const m of s.messages) expect(forbiddenKeysIn(m)).toEqual([]);
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await server?.close();
    server = undefined;
    cleanup();
  });

  /** rng null = no start scenarios: everyone at the inn (locations[0]) with HP 100 / 100, 0 coins. */
  async function boot(rng: Rng | null = null): Promise<Table> {
    server = await startTestServer(dataDir, { phaseResolver: resolver, rng });
    return startedTable(server, false);
  }

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  const gameIdOf = (t: Table) => (server!.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
  const state = (t: Table) => ensurePhaseState(server!.orm, gameIdOf(t), CLOCK);
  const me = (t: Table, seat: Seat) => state(t).players[seat.memberId]!;
  const row = (seat: Seat) => server!.orm.select().from(character).where(eq(character.memberId, seat.memberId)).get()!;
  const put = (seat: Seat, locationId: string) => expect(moveCharacter(server!.orm, seat.memberId, locationId, CLOCK)).toBe(true);
  const setCoins = (seat: Seat, coins: number) => server!.orm.update(character).set({ coins }).where(eq(character.memberId, seat.memberId)).run();
  /** Sets the engine state (and the character's Max HP) before anyone is in the room. */
  function setPlayer(t: Table, seat: Seat, patch: { hp?: number; hpMax?: number; stamina?: number }, at: Partial<Pick<PhaseState, 'day' | 'phase' | 'turn'>> = {}) {
    if (patch.hpMax !== undefined) server!.orm.update(character).set({ hpMax: patch.hpMax }).where(eq(character.memberId, seat.memberId)).run();
    const s = state(t);
    savePhaseState(server!.orm, gameIdOf(t), { ...s, ...at, players: { ...s.players, [seat.memberId]: { ...s.players[seat.memberId]!, ...patch } } }, CLOCK);
  }

  type Kind = { rest?: boolean; train?: boolean };
  async function send(client: RoomClient, text: string, kind: Kind = {}) {
    const from = client.messages.length;
    client.send({ type: 'action', text, visibility: 'public', ...kind });
    return client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from);
  }

  /** A sends `kind`, B and C a plain action; waits until the next turn collects. */
  async function turn(t: Table, clients: RoomClient[], kind: Kind, text = 'พักผ่อน') {
    const s = state(t);
    const from = clients[0]!.messages.length;
    expect(await send(clients[0]!, text, kind)).toEqual({ type: 'action_accepted' });
    for (const c of clients.slice(1)) expect(await send(c, 'เดินเล่น')).toEqual({ type: 'action_accepted' });
    const next = s.turn === 1 ? { day: s.day, phase: s.phase, turn: 2 } : null;
    await clients[0]!.waitFor(
      (m: RoomServerMessage) =>
        m.type === 'room' && m.status === 'collecting' && (next ? m.day === next.day && m.phase === next.phase && m.turn === 2 : m.turn === 1),
      from,
    );
  }

  const everyone = async (t: Table) => [await enter(t.a), await enter(t.b), await enter(t.c)];

  it('C1: REST at the inn with 10 coins → 5 coins, Stamina +10 (max 30); with 4 coins it is refused "เงินไม่พอ"', async () => {
    const t = await boot();
    setCoins(t.a, 10);
    setPlayer(t, t.a, { stamina: 15 });
    const clients = await everyone(t);
    await turn(t, clients, { rest: true });
    expect(me(t, t.a).stamina).toBe(25);
    expect(row(t.a)).toMatchObject({ coins: 5, stamina: 25 });

    await turn(t, clients, { rest: true });
    expect(me(t, t.a).stamina).toBe(30);
    expect(row(t.a).coins).toBe(0);

    setCoins(t.a, 4);
    const refused = await send(clients[0]!, 'พักที่โรงเตี๊ยม', { rest: true });
    expect(refused).toMatchObject({ type: 'action_rejected', code: 'not_enough_coins' });
    expect(refused.type === 'action_rejected' ? refused.message : '').toContain('เงินไม่พอ');
    expect(row(t.a).coins).toBe(4);
  });

  it('C2: REST at the infirmary: one turn HP +15 and Stamina +8; both turns of the period → HP = Max HP', async () => {
    const t = await boot();
    put(t.a, 'clinic');
    setPlayer(t, t.a, { hp: 5, stamina: 10 });
    const clients = await everyone(t);
    await turn(t, clients, { rest: true });
    expect(me(t, t.a)).toMatchObject({ hp: 20, stamina: 18 });
    await turn(t, clients, { rest: true });
    expect(me(t, t.a).hp).toBe(100);
    // +8 again (the period's end_of_period loot restore may add on top: GEN-055).
    expect(me(t, t.a).stamina).toBeGreaterThanOrEqual(26);
    expect(row(t.a)).toMatchObject({ hp: 100, coins: 0 });
  });

  it('C3: TRAIN at the guild: Max HP 30 → 33; again the same day is refused; 45 is the ceiling; 44 → 45', async () => {
    const t = await boot();
    setPlayer(t, t.a, { hp: 20, hpMax: 30 });
    let clients = await everyone(t);
    await turn(t, clients, { train: true }, 'ฝึกซ้อมที่ลานกิลด์');
    expect(me(t, t.a)).toMatchObject({ hpMax: 33, hp: 20 });
    expect(row(t.a)).toMatchObject({ hpMax: 33, hp: 20 });

    const again = await send(clients[0]!, 'ฝึกอีกรอบ', { train: true });
    expect(again).toMatchObject({ type: 'action_rejected', code: 'train_used' });
    expect(again.type === 'action_rejected' ? again.message : '').toMatch(/วันนี้/);
    await Promise.all(clients.map((c) => c.close()));

    setPlayer(t, t.a, { hpMax: 45, hp: 45 }, { day: 2, phase: 'EOSORIA', turn: 1 });
    clients = await everyone(t);
    const capped = await send(clients[0]!, 'ฝึกซ้อม', { train: true });
    expect(capped).toMatchObject({ type: 'action_rejected', code: 'train_cap' });
    expect(capped.type === 'action_rejected' ? capped.message : '').toContain('เพดาน');
    await Promise.all(clients.map((c) => c.close()));

    setPlayer(t, t.a, { hpMax: 44 });
    clients = await everyone(t);
    await turn(t, clients, { train: true }, 'ฝึกซ้อม');
    expect(me(t, t.a).hpMax).toBe(45);
    expect(row(t.a).hpMax).toBe(45);
  });

  it('C3: TRAIN away from the guild is refused', async () => {
    const t = await boot();
    put(t.a, 'fountain');
    setPlayer(t, t.a, { hp: 30, hpMax: 30 });
    const [a] = await everyone(t);
    const refused = await send(a!, 'ฝึกซ้อม', { train: true });
    expect(refused).toMatchObject({ type: 'action_rejected', code: 'train_not_here' });
    expect(refused.type === 'action_rejected' ? refused.message : '').toContain('กิลด์');
  });

  it('C4: a Public action at the fountain that moves Reputation 4 moves it 6; at the inn 4', async () => {
    const t = await boot();
    put(t.a, 'fountain');
    const gameId = gameIdOf(t);
    const effects = (repDelta: number) => ({ repDelta, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] });
    const perform = (seat: Seat): PhaseAction => ({
      actorId: seat.memberId,
      proposal: {
        actionId: `act-${seat.memberId}`,
        kind: 'general',
        tags: [],
        opposed: false,
        staminaCost: 3,
        visibility: 'public',
        target: null,
        check: { type: 'dc', dc: 5 },
        modifiers: [],
        witnessNpcIds: [],
        repDeltaIfCaught: 0,
        onSuccess: effects(4),
        onFail: effects(4),
        reason: 'ร้องเพลงกลางลาน',
      },
      targetPlayer: null,
      moveTo: null,
      awareness: 'normal',
    });
    expect(applyPhaseActions(server!.orm, gameId, [perform(t.a)], new ReplayRng([10, 15]), CLOCK, { assets, day: 1 }).ok).toBe(true);
    expect(row(t.a).reputation).toBe(6);
    expect(applyPhaseActions(server!.orm, gameId, [perform(t.b)], new ReplayRng([10, 15]), CLOCK, { assets, day: 1 }).ok).toBe(true);
    expect(row(t.b).reputation).toBe(4);
  });

  it('C5: the dishwasher (start scenario) RESTs at the inn: Stamina +12', async () => {
    const t = await boot(new ScriptedRng([DISHWASHER, MUSICIAN, MUSICIAN]));
    expect(row(t.a).coins).toBe(20);
    setPlayer(t, t.a, { stamina: 10 });
    const clients = await everyone(t);
    await turn(t, clients, { rest: true });
    expect(me(t, t.a).stamina).toBe(22);
    expect(row(t.a).coins).toBe(15);
  });

  it('C6: REST at a place with no special mechanics is the normal rest (+8) and costs nothing', async () => {
    const t = await boot();
    put(t.a, 'fountain');
    setCoins(t.a, 10);
    setPlayer(t, t.a, { stamina: 10 });
    const clients = await everyone(t);
    await turn(t, clients, { rest: true });
    expect(me(t, t.a).stamina).toBe(18);
    expect(row(t.a).coins).toBe(10);
  });

  it('Q-218: a night REST recovers by the place\'s Rest_Quality: forest poor 15, fountain normal 20, inn good 25 (5 coins), infirmary excellent 30', async () => {
    const t = await boot();
    const night = { day: 1, phase: 'NOCTHERION' as const, turn: 1 as const };
    for (const [place, gain, coins] of [['forest', 15, 10], ['fountain', 20, 10], ['inn', 25, 5], ['clinic', 30, 10]] as const) {
      put(t.a, place);
      setCoins(t.a, 10);
      setPlayer(t, t.a, { stamina: 0 }, night);
      const clients = await everyone(t);
      await turn(t, clients, { rest: true }, 'นอน');
      expect(me(t, t.a).stamina, place).toBe(gain);
      expect(row(t.a).coins, place).toBe(coins);
      await Promise.all(clients.map((c) => c.close()));
    }
  });

  it('GEN-113: the text "นอน" alone is a REST with no rest flag: inn pays 5, forest poor quality; not enough coins is refused; an action on another is not REST', async () => {
    const t = await boot();
    const night = { day: 1, phase: 'NOCTHERION' as const, turn: 1 as const };
    for (const [place, gain, coins] of [['inn', 25, 5], ['forest', 15, 10]] as const) {
      put(t.a, place);
      setCoins(t.a, 10);
      setPlayer(t, t.a, { stamina: 0 }, night);
      const clients = await everyone(t);
      await turn(t, clients, {}, 'นอน');
      expect(me(t, t.a).stamina, place).toBe(gain);
      expect(row(t.a).coins, place).toBe(coins);
      await Promise.all(clients.map((c) => c.close()));
    }
    put(t.a, 'inn');
    setCoins(t.a, 4);
    const clients = await everyone(t);
    const refused = await send(clients[0]!, 'พักผ่อน');
    expect(refused).toMatchObject({ type: 'action_rejected', code: 'not_enough_coins' });
    expect(refused.type === 'action_rejected' ? refused.message : '').toContain('เงินไม่พอ');
    expect(await send(clients[0]!, 'หลอกให้ยามนอนหลับ')).toEqual({ type: 'action_accepted' });
    expect(row(t.a).coins).toBe(4);
  });

  it('Q-209: the castaway RESTs on the coast HP +3, not inland; the patient RESTs HP +5 anywhere', async () => {
    const t = await boot(new ScriptedRng([CASTAWAY, PATIENT, MUSICIAN]));
    setPlayer(t, t.a, { hp: 10, stamina: 10 });
    setPlayer(t, t.b, { hp: 10, stamina: 10 });
    let clients = await everyone(t);
    // A at the sea, B at the infirmary: both rest (B's +5 adds to the infirmary's +15).
    const from = clients[0]!.messages.length;
    expect(await send(clients[0]!, 'พักริมหาด', { rest: true })).toEqual({ type: 'action_accepted' });
    expect(await send(clients[1]!, 'นอนพัก', { rest: true })).toEqual({ type: 'action_accepted' });
    expect(await send(clients[2]!, 'เดินเล่น')).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor((m) => m.type === 'room' && m.status === 'collecting' && m.turn === 2, from);
    expect(me(t, t.a)).toMatchObject({ hp: 13, stamina: 18 });
    expect(me(t, t.b)).toMatchObject({ hp: 30, stamina: 18 });
    await Promise.all(clients.map((c) => c.close()));

    put(t.a, 'fountain');
    put(t.b, 'fountain');
    setPlayer(t, t.a, { hp: 10 });
    setPlayer(t, t.b, { hp: 10 });
    clients = await everyone(t);
    const from2 = clients[0]!.messages.length;
    expect(await send(clients[0]!, 'พัก', { rest: true })).toEqual({ type: 'action_accepted' });
    expect(await send(clients[1]!, 'พัก', { rest: true })).toEqual({ type: 'action_accepted' });
    expect(await send(clients[2]!, 'เดินเล่น')).toEqual({ type: 'action_accepted' });
    await clients[0]!.waitFor((m) => m.type === 'room' && m.status === 'collecting' && m.phase === 'SOLARION', from2);
    expect(me(t, t.a).hp).toBe(10);
    expect(me(t, t.b).hp).toBe(15);
  });

  it('Q-209: the laborer spends 1 Stamina less on an action outdoors (farmland), not indoors (inn)', async () => {
    const t = await boot(new ScriptedRng([LABORER, MUSICIAN, MUSICIAN]));
    const gameId = gameIdOf(t);
    const noEffects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };
    const work = (id: string): PhaseAction => ({
      actorId: t.a.memberId,
      proposal: {
        actionId: id,
        kind: 'general',
        tags: [],
        opposed: false,
        staminaCost: 3,
        visibility: 'public',
        target: null,
        check: { type: 'dc', dc: 5 },
        modifiers: [],
        witnessNpcIds: [],
        repDeltaIfCaught: 0,
        onSuccess: noEffects,
        onFail: noEffects,
        reason: 'ช่วยเก็บเกี่ยว',
      },
      targetPlayer: null,
      moveTo: null,
      awareness: 'normal',
    });
    const stamina = () => row(t.a).stamina;
    const before = stamina();
    expect(applyPhaseActions(server!.orm, gameId, [work('a1')], new ReplayRng([10, 15]), CLOCK, { assets, day: 1 }).ok).toBe(true);
    expect(stamina()).toBe(before - 2);
    put(t.a, 'inn');
    expect(applyPhaseActions(server!.orm, gameId, [work('a2')], new ReplayRng([10, 15]), CLOCK, { assets, day: 1 }).ok).toBe(true);
    expect(stamina()).toBe(before - 5);
  });
});
