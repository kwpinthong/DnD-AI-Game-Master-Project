import { CompanionsResponse, SurroundingsResponse, type Scenario } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changeNpcAffinity,
  checkNpcEvolution,
  grantNpcReward,
  npcStateFor,
  recordNpcActivity,
  setNpcFlag,
  spawnNpc,
} from '../src/companions/store.ts';
import type { RunningServer } from '../src/server.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import { moveCharacter, npcBondsOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { caller, CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

const MARKET = 'market';
/** Test ids for the sheet's NPCs, by the first alias of each NPC tab row. */
const IDS: Readonly<Record<string, string>> = {
  โนอา: 'noa',
  ลูเซีย: 'lucia',
  แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า: 'elena',
  ทหารยามหน้าตาบึ้งตึง: 'garrett',
  ชายชุดคลุมมอมแมมในตรอกมืด: 'victor',
  พ่อค้าเร่ผู้สวมแว่นหนา: 'marcus',
  'ลอร์ดจูเลียน แวนเดอร์บิลต์': 'julian',
  'อาร์คบิชอป มัลคอล์ม': 'malcolm',
  'เลดี้เซเรน่า แห่งหอจดหมายเหตุ': 'serena',
  ออเรเลีย: 'aurelia',
  น็อกทิส: 'noctis',
  แอสทรา: 'astra',
};

describe('NPC companions from the sheet NPC tab (GEN-054)', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = makeTempDir());
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    cleanup();
  });

  const gameIdOf = (seat: Seat) =>
    (server!.db.prepare('select game_id from member where id = ?').get(seat.memberId) as { game_id: string }).game_id;

  /** A started game whose scenario NPCs are the sheet's NPCs, all at the market with the three players. */
  async function table(): Promise<Table> {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    const gameId = gameIdOf(t.a);
    const scenario = getGameScenario(server.orm, gameId)!;
    const npcs: Scenario['npcs'] = server.assets.npcs.map((n) => ({
      id: IDS[n.aliases[0]!]!,
      name: n.aliases[0]!,
      otherNames: [],
      alias: n.aliases[0]!,
      rank: n.grade === 'SS' ? 'F' : n.grade,
      locationId: MARKET,
      personality: '',
      obsTrait: 0,
      gmNote: '',
    }));
    const updated = updateGameScenario(server.orm, gameId, { ...scenario, npcs, timeline: scenario.timeline.map((e) => ({ ...e, npcIds: [] })) }, CLOCK);
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    for (const seat of [t.a, t.b, t.c]) moveCharacter(server.orm, seat.memberId, MARKET, CLOCK);
    return t;
  }

  async function npcsSeenBy(t: Table, who: Seat) {
    const res = await t.call('GET', '/api/game/surroundings', { token: who.token });
    const view = SurroundingsResponse.parse(res.body);
    if (view.view !== 'player') throw new Error('expected a player view');
    return view.npcs;
  }

  /** NPC id → the ref the player sees, matched through the store (the player only has ref + name). */
  async function refs(t: Table, who: Seat): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of Object.values(IDS)) out[id] = npcStateFor(server!.orm, server!.assets, who.memberId, id)!.ref;
    const seen = new Set((await npcsSeenBy(t, who)).map((n) => n.ref));
    for (const ref of Object.values(out)) expect(seen.has(ref)).toBe(true);
    return out;
  }

  async function companions(t: Table, who: Seat) {
    const res = await t.call('GET', '/api/game/companions', { token: who.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CompanionsResponse.parse(res.body).companions;
  }

  const save = (t: Table, who: Seat, ref: string) => t.call('POST', '/api/game/companions', { token: who.token, body: { ref } });
  const release = (t: Table, who: Seat, ref: string) => t.call('DELETE', `/api/game/companions/${ref}`, { token: who.token });

  const setKarma = (seat: Seat, karma: number) => server!.db.prepare('update character set karma = ? where member_id = ?').run(karma, seat.memberId);
  const at = (day: number) => ({ day, now: CLOCK });

  /** Raises affinity in legal steps of at most +10 per action (on `day`). */
  function raiseAffinity(seat: Seat, npcId: string, to: number, day = 1) {
    let now = affinity(seat, npcId);
    for (let steps = 0; now !== to; steps++) {
      if (steps > 25) throw new Error(`affinity stuck at ${now}`);
      const step = Math.max(-10, Math.min(10, to - now));
      const r = changeNpcAffinity(server!.orm, server!.assets, seat.memberId, npcId, step, at(day));
      if (!r.ok) throw new Error(r.error.code);
      now = r.after;
    }
  }

  const affinity = (seat: Seat, npcId: string) => npcBondsOf(server!.orm, seat.memberId).find((b) => b.npcId === npcId)?.affinity ?? 0;
  const state = (seat: Seat, npcId: string) => npcStateFor(server!.orm, server!.assets, seat.memberId, npcId)!;
  const rewardRows = (seat: Seat) =>
    (server!.db.prepare('select npc_id, reward, kind from npc_reward where member_id = ? order by reward').all(seat.memberId) as {
      npc_id: string;
      reward: string;
      kind: string;
    }[]).map((r) => `${r.npc_id}:${r.kind}:${r.reward}`);

  it('C1: with 3 NPCs saved, a 4th is refused until one is released', async () => {
    const t = await table();
    const r = await refs(t, t.a);
    for (const id of ['noa', 'elena', 'julian']) expect((await save(t, t.a, r[id]!)).status).toBe(201);
    const fourth = await save(t, t.a, r.aurelia!);
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ code: 'companion_limit' });
    expect(await companions(t, t.a)).toHaveLength(3);

    expect((await release(t, t.a, r.elena!)).status).toBe(200);
    expect((await save(t, t.a, r.aurelia!)).status).toBe(201);
    expect((await companions(t, t.a)).map((c) => c.ref).sort()).toEqual([r.noa, r.julian, r.aurelia].sort());
    expect(await companions(t, t.b)).toEqual([]);

    // Twice, unknown, released non-companion, NPC elsewhere.
    expect((await save(t, t.a, r.noa!)).status).toBe(409);
    expect((await save(t, t.a, 'no-such-ref')).status).toBe(404);
    expect((await release(t, t.a, r.marcus!)).status).toBe(404);
    moveCharacter(server!.orm, t.b.memberId, 'temple', CLOCK);
    expect((await save(t, t.b, r.marcus!)).body).toMatchObject({ code: 'npc_not_found' });
  });

  it('C1: the main companion is the one with the highest affinity; on a tie, the one saved first', async () => {
    const t = await table();
    const r = await refs(t, t.a);
    for (const id of ['elena', 'noa', 'julian']) await save(t, t.a, r[id]!);
    expect((await companions(t, t.a))[0]).toMatchObject({ ref: r.elena, role: 'main' });

    raiseAffinity(t.a, 'julian', 4);
    expect((await companions(t, t.a)).map((c) => [c.ref, c.role])).toEqual([
      [r.julian, 'main'],
      [r.elena, 'secondary'],
      [r.noa, 'secondary'],
    ]);
    raiseAffinity(t.a, 'elena', 4);
    expect((await companions(t, t.a))[0]).toMatchObject({ ref: r.elena, role: 'main' });
  });

  it('C2: an affinity change of +15 in one action is rejected and nothing changes', async () => {
    const t = await table();
    raiseAffinity(t.a, 'marcus', 5);
    const res = changeNpcAffinity(server!.orm, server!.assets, t.a.memberId, 'marcus', 15, at(1));
    expect(res).toMatchObject({ ok: false, error: { code: 'out_of_range' } });
    expect(affinity(t.a, 'marcus')).toBe(5);
    expect(changeNpcAffinity(server!.orm, server!.assets, t.a.memberId, 'nobody', 3, at(1))).toMatchObject({ ok: false, error: { code: 'unknown_npc' } });
  });

  it('C3: the grade B nun shows her sheet alias until +9, then ซิสเตอร์เอเลน่า and gives her +9 rewards once', async () => {
    const t = await table();
    const r = await refs(t, t.a);
    await save(t, t.a, r.elena!);
    const seen = async () => (await npcsSeenBy(t, t.a)).find((n) => n.ref === r.elena);

    raiseAffinity(t.a, 'elena', 8);
    expect(await seen()).toEqual({ ref: r.elena, name: 'แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า', nameRevealed: false });
    expect(rewardRows(t.a)).toEqual([]);

    const ninth = changeNpcAffinity(server!.orm, server!.assets, t.a.memberId, 'elena', 1, at(2));
    expect(ninth).toMatchObject({ ok: true, after: 9, nameRevealed: true });
    expect(await seen()).toEqual({ ref: r.elena, name: 'ซิสเตอร์เอเลน่า', nameRevealed: true });
    expect((await companions(t, t.a))[0]).toMatchObject({ name: 'ซิสเตอร์เอเลน่า', nameRevealed: true });
    expect(rewardRows(t.a)).toEqual(['elena:item:Blessed Loaf of Dawn', 'elena:item:Silver Rosary of Hearth']);

    // Down and up again: the name stays, the rewards are not given twice.
    raiseAffinity(t.a, 'elena', 2);
    raiseAffinity(t.a, 'elena', 12);
    expect(await seen()).toMatchObject({ name: 'ซิสเตอร์เอเลน่า' });
    expect(rewardRows(t.a)).toHaveLength(2);
    // Another player still sees the alias.
    expect((await npcsSeenBy(t, t.b)).find((n) => n.ref === r.elena)).toMatchObject({ name: 'แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า', nameRevealed: false });
  });

  it('C3 (Q-103 / Q-220): grades F / A show their sheet name from the start; B its alias', async () => {
    const t = await table();
    const r = await refs(t, t.a);
    const byRef = new Map((await npcsSeenBy(t, t.a)).map((n) => [n.ref, n]));
    expect(byRef.get(r.noa!)).toEqual({ ref: r.noa, name: 'โนอา', nameRevealed: true });
    expect(byRef.get(r.lucia!)).toEqual({ ref: r.lucia, name: 'ลูเซีย', nameRevealed: true });
    expect(byRef.get(r.julian!)).toEqual({ ref: r.julian, name: 'ลอร์ดจูเลียน แวนเดอร์บิลต์', nameRevealed: true });
    expect(byRef.get(r.serena!)).toEqual({ ref: r.serena, name: 'เลดี้เซเรน่า แห่งหอจดหมายเหตุ', nameRevealed: true });
    expect(byRef.get(r.garrett!)).toMatchObject({ name: 'ทหารยามหน้าตาบึ้งตึง', nameRevealed: false });
  });

  it('Q-219: grade S shows its sheet Public_Alias until met / awakened; awakening reveals the real name to that player only', async () => {
    const t = await table();
    const r = await refs(t, t.a);
    const seen = async (who: Seat, ref: string) => (await npcsSeenBy(t, who)).find((n) => n.ref === ref);
    expect(await seen(t.a, r.aurelia!)).toEqual({ ref: r.aurelia, name: 'ภูตแห่งแสงในแท่นบูชา', nameRevealed: false });
    expect(await seen(t.a, r.noctis!)).toEqual({ ref: r.noctis, name: 'เงาในรอยแยกใต้แท่นพิธี', nameRevealed: false });
    expect(await seen(t.a, r.astra!)).toEqual({ ref: r.astra, name: 'ผู้เฝ้ามองเส้นขอบฟ้า', nameRevealed: false });
    expect(state(t.a, 'aurelia')).toMatchObject({ name: 'ภูตแห่งแสงในแท่นบูชา', nameRevealed: false });
    // Affinity alone (the grade B rule) does not reveal a grade S name.
    raiseAffinity(t.a, 'astra', 20);
    expect(await seen(t.a, r.astra!)).toMatchObject({ name: 'ผู้เฝ้ามองเส้นขอบฟ้า', nameRevealed: false });

    // Awakened (Aurelia: karma +50 and the prayer at the secret altar): the real name, and the narration
    // reveal flag (npc_bond.name_revealed) for this player.
    setKarma(t.a, 50);
    setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'aurelia', 'prayed_at_secret_altar', at(3));
    expect(state(t.a, 'aurelia')).toMatchObject({ evolved: true });
    expect(await seen(t.a, r.aurelia!)).toEqual({ ref: r.aurelia, name: 'ออเรเลีย', nameRevealed: true });
    expect(npcBondsOf(server!.orm, t.a.memberId).find((b) => b.npcId === 'aurelia')?.nameRevealed).toBe(true);
    const rB = await refs(t, t.b);
    expect(await seen(t.b, rB.aurelia!)).toEqual({ ref: rB.aurelia, name: 'ภูตแห่งแสงในแท่นบูชา', nameRevealed: false });
  });

  it('C4: Noa at +70 with karma +70 becomes Seraphiel (SS), karma -70 Malakor; +69 on either stays F', async () => {
    const t = await table();
    setKarma(t.a, 70);
    setKarma(t.b, -70);
    setKarma(t.c, 70);
    raiseAffinity(t.a, 'noa', 70);
    raiseAffinity(t.b, 'noa', 70);
    raiseAffinity(t.c, 'noa', 69);

    expect(state(t.a, 'noa')).toMatchObject({ grade: 'SS', alignment: 'Good', name: 'Seraphiel, Herald of Dawn' });
    expect(state(t.b, 'noa')).toMatchObject({ grade: 'SS', alignment: 'Evil', name: 'Malakor, Blood Moon Incarnate' });
    expect(state(t.c, 'noa')).toMatchObject({ grade: 'F', alignment: null });
    expect(rewardRows(t.a)).toEqual(['noa:item:Chalice of the First Dawn', 'noa:skill:The First Light']);
    expect(rewardRows(t.b)).toEqual(['noa:item:Grimoire of the Blood Moon', 'noa:skill:ORDO TENEBRIS']);
    expect(rewardRows(t.c)).toEqual([]);

    // Karma 69 with affinity 100: still F. Karma reaching 70 later evolves on the next check.
    setKarma(t.c, 69);
    raiseAffinity(t.c, 'noa', 100);
    expect(checkNpcEvolution(server!.orm, server!.assets, t.c.memberId, at(3))).toEqual([]);
    expect(state(t.c, 'noa').grade).toBe('F');
    setKarma(t.c, 70);
    expect(checkNpcEvolution(server!.orm, server!.assets, t.c.memberId, at(3))).toEqual([{ npcId: 'noa', grade: 'SS', alignment: 'Good' }]);
    // Once only, even if karma turns.
    setKarma(t.c, -90);
    expect(checkNpcEvolution(server!.orm, server!.assets, t.c.memberId, at(4))).toEqual([]);
    expect(state(t.c, 'noa')).toMatchObject({ grade: 'SS', alignment: 'Good' });
    // The player sees the new name.
    const r = await refs(t, t.a);
    expect((await npcsSeenBy(t, t.a)).find((n) => n.ref === r.noa)).toMatchObject({ name: 'Seraphiel, Herald of Dawn' });
  });

  it('C5: Lucia at +70 with 3 distinct periods a day on days 4-6 and karma -1..+1 becomes Chronos-Zero (SS)', async () => {
    const t = await table();
    const periods = ['EOSORIA', 'SOLARION', 'HESPERION'] as const;
    for (const seat of [t.a, t.b, t.c]) {
      setKarma(seat, 0);
      raiseAffinity(seat, 'lucia', 70);
    }
    // A: days 4, 5, 6. B: days 4 and 6 only (a day missing). C: days 3, 4, 5 (day 3 does not count).
    const plan: [Seat, number[]][] = [
      [t.a, [4, 5, 6]],
      [t.b, [4, 6]],
      [t.c, [3, 4, 5]],
    ];
    for (const [seat, days] of plan) {
      for (const day of days) for (const period of periods) recordNpcActivity(server!.orm, server!.assets, seat.memberId, 'lucia', period, at(day));
    }
    expect(state(t.a, 'lucia')).toMatchObject({ grade: 'SS', alignment: 'Neutral', name: 'Chronos-Zero, The Unbound Arbiter' });
    expect(state(t.b, 'lucia').grade).toBe('F');
    expect(state(t.c, 'lucia').grade).toBe('F');
    expect(rewardRows(t.a)).toEqual(['lucia:skill:I AM UNTOUCHED', 'lucia:item:Pendulum of Zero']);
    expect(recordNpcActivity(server!.orm, server!.assets, t.b.memberId, 'lucia', 'NOCTHERION', at(13))).toMatchObject({ ok: false });
  });

  it('C5: karma outside -1..+1 on one streak day stops Lucia', async () => {
    const t = await table();
    setKarma(t.a, 0);
    raiseAffinity(t.a, 'lucia', 70);
    for (const day of [4, 5, 6]) {
      if (day === 5) setKarma(t.a, 2);
      for (const period of ['EOSORIA', 'SOLARION', 'HESPERION'] as const) recordNpcActivity(server!.orm, server!.assets, t.a.memberId, 'lucia', period, at(day));
      setKarma(t.a, 0);
    }
    expect(state(t.a, 'lucia').grade).toBe('F');
  });

  it('C6: Lord Julian with both flags (villagers on day 7 + the high priest) becomes S and unlocks Sanctuary Aegis', async () => {
    const t = await table();
    // Wrong day: refused, nothing stored.
    expect(setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'julian', 'protected_villagers', at(6))).toMatchObject({ ok: false, error: { code: 'wrong_day' } });
    expect(setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'julian', 'not_a_flag', at(7))).toMatchObject({ ok: false, error: { code: 'unknown_flag' } });
    expect(state(t.a, 'julian').flags).toEqual({});

    expect(setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'julian', 'protected_villagers', at(7))).toMatchObject({ ok: true, evolved: null });
    expect(state(t.a, 'julian').grade).toBe('A');
    expect(setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'julian', 'exposed_high_priest', at(8))).toMatchObject({
      ok: true,
      evolved: { npcId: 'julian', grade: 'S', alignment: null },
    });
    expect(state(t.a, 'julian')).toMatchObject({ grade: 'S', name: 'ลอร์ดจูเลียน ผู้พิทักษ์พันธสัญญา' });
    expect(rewardRows(t.a)).toEqual(['julian:skill:Sanctuary Aegis']);

    // Only one flag: still A.
    setNpcFlag(server!.orm, server!.assets, t.b.memberId, 'julian', 'exposed_high_priest', at(8));
    expect(state(t.b, 'julian').grade).toBe('A');
    expect(rewardRows(t.b)).toEqual([]);
  });

  it('C6: grade S awakens on karma + deeds (Noctis needs karma below -50 and 3 deeds)', async () => {
    const t = await table();
    setKarma(t.a, -51);
    for (let i = 0; i < 2; i++) setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'noctis', 'crushed_hope', at(2));
    expect(state(t.a, 'noctis')).toMatchObject({ grade: 'S', alignment: null, evolved: false });
    setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'noctis', 'crushed_hope', at(3));
    expect(state(t.a, 'noctis')).toMatchObject({ evolved: true, flags: { crushed_hope: 3 } });
    expect(rewardRows(t.a)).toEqual(['noctis:skill:Abyssal Miasma']);
  });

  it('C7: a reward outside the NPC Rewards, or not open yet, is refused and nothing changes; SS cannot spawn', async () => {
    const t = await table();
    const before = rewardRows(t.a);
    // Garrett's item from the nun; Noa's SS reward while Noa is still F; a made-up item.
    expect(grantNpcReward(server!.orm, server!.assets, t.a.memberId, 'elena', 'Mantle of the Martyr', CLOCK)).toMatchObject({ ok: false, error: { code: 'not_in_rewards' } });
    expect(grantNpcReward(server!.orm, server!.assets, t.a.memberId, 'noa', 'The First Light', CLOCK)).toMatchObject({ ok: false, error: { code: 'not_unlocked' } });
    expect(grantNpcReward(server!.orm, server!.assets, t.a.memberId, 'elena', 'Excalibur', CLOCK)).toMatchObject({ ok: false, error: { code: 'not_in_rewards' } });
    // The +9 rewards come only with the name.
    expect(grantNpcReward(server!.orm, server!.assets, t.a.memberId, 'elena', 'Blessed Loaf of Dawn', CLOCK)).toMatchObject({ ok: false, error: { code: 'not_unlocked' } });
    expect(rewardRows(t.a)).toEqual(before);

    // The quest reward of the same NPC is fine, once.
    expect(grantNpcReward(server!.orm, server!.assets, t.a.memberId, 'elena', 'Prism of Truth', CLOCK)).toMatchObject({ ok: true, kind: 'item' });
    expect(grantNpcReward(server!.orm, server!.assets, t.a.memberId, 'elena', 'Prism of Truth', CLOCK)).toMatchObject({ ok: false, error: { code: 'already_given' } });
    // Grade A gives its own A-grade items before S.
    expect(grantNpcReward(server!.orm, server!.assets, t.a.memberId, 'julian', 'Censer of Purging Flame', CLOCK)).toMatchObject({ ok: true });

    const gameId = gameIdOf(t.a);
    const scenarioBefore = getGameScenario(server!.orm, gameId);
    const ss = spawnNpc(server!.orm, gameId, { id: 'new-god', name: 'เทพใหม่', alias: 'ผู้มาเยือน', rank: 'SS', locationId: MARKET }, CLOCK);
    expect(ss).toMatchObject({ ok: false, error: { code: 'grade_not_spawnable' } });
    expect(getGameScenario(server!.orm, gameId)).toEqual(scenarioBefore);
    expect(spawnNpc(server!.orm, gameId, { id: 'stray', name: 'เด็กหลงทาง', alias: 'เด็กหลงทาง', rank: 'F', locationId: MARKET }, CLOCK)).toMatchObject({ ok: true });
    expect(getGameScenario(server!.orm, gameId)!.npcs.map((n) => n.id)).toContain('stray');
  });

  it('C8: after a restart, companions, affinity, grades, flags and revealed names are the same', async () => {
    const t = await table();
    const r = await refs(t, t.a);
    for (const id of ['noa', 'elena', 'julian']) await save(t, t.a, r[id]!);
    setKarma(t.a, -75);
    raiseAffinity(t.a, 'noa', 70);
    raiseAffinity(t.a, 'elena', 12);
    setNpcFlag(server!.orm, server!.assets, t.a.memberId, 'julian', 'protected_villagers', at(7));

    const snapshot = async (call: Table) => ({
      list: await companions(call, t.a),
      seen: await npcsSeenBy(call, t.a),
      bonds: npcBondsOf(server!.orm, t.a.memberId),
      states: Object.values(IDS).map((id) => state(t.a, id)),
      rewards: rewardRows(t.a),
    });
    const before = await snapshot(t);
    expect(before.states.find((s) => s.npcId === 'noa')).toMatchObject({ grade: 'SS', alignment: 'Evil' });
    expect(before.list.find((c) => c.ref === r.elena)).toMatchObject({ name: 'ซิสเตอร์เอเลน่า' });

    await server!.close();
    server = await startTestServer(dataDir);
    expect(await snapshot({ ...t, call: caller(server) })).toEqual(before);
  });
});
