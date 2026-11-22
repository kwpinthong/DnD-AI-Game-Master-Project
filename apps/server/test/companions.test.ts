import { CompanionsResponse, defaultScenario, SurroundingsResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changeNpcAffinity,
  checkNpcRewardFor,
  evolveNpcsAtPhaseEnd,
  markCrisisAid,
  npcGradeFor,
} from '../src/companions/store.ts';
import type { RunningServer } from '../src/server.ts';
import { npcBondsOf, moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

const npcs = defaultScenario().npcs;
const npc = (id: string) => npcs.find((n) => n.id === id)!;
// At the market: orphan (F), merchant (B), cult-acolyte (B), spy (A).
const MARKET = 'market';

describe('NPC companions, grades and evolution (GEN-054)', { timeout: 60_000 }, () => {
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

  async function table(): Promise<Table> {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, false);
    for (const seat of [t.a, t.b, t.c]) moveCharacter(server.orm, seat.memberId, MARKET, CLOCK);
    return t;
  }

  /** NPC ref by NPC id, read the way a player gets it: from GET /api/game/surroundings (alias → ref). */
  async function refsAtMyPlace(t: Table, who: Seat): Promise<Record<string, string>> {
    const res = await t.call('GET', '/api/game/surroundings', { token: who.token });
    const view = SurroundingsResponse.parse(res.body);
    if (view.view !== 'player') throw new Error('expected a player view');
    const refs: Record<string, string> = {};
    for (const n of npcs.filter((n) => n.locationId === MARKET)) {
      const seen = view.npcs.find((v) => v.name === n.alias || v.name === n.name);
      if (seen) refs[n.id] = seen.ref;
    }
    return refs;
  }

  async function companions(t: Table, who: Seat) {
    const res = await t.call('GET', '/api/game/companions', { token: who.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CompanionsResponse.parse(res.body).companions;
  }

  const save = (t: Table, who: Seat, ref: string) => t.call('POST', '/api/game/companions', { token: who.token, body: { ref } });
  const release = (t: Table, who: Seat, ref: string) => t.call('DELETE', `/api/game/companions/${ref}`, { token: who.token });

  function setKarma(seat: Seat, karma: number) {
    server!.db.prepare('update character set karma = ? where member_id = ?').run(karma, seat.memberId);
  }

  /** Raises affinity in legal steps of at most +10 per action. */
  function raiseAffinity(seat: Seat, npcId: string, to: number) {
    let now = bondAffinity(seat, npcId);
    while (now < to) {
      const r = changeNpcAffinity(server!.orm, seat.memberId, npcId, Math.min(10, to - now), CLOCK);
      if (!r.ok) throw new Error(r.error.code);
      now = r.after;
    }
  }

  const bondAffinity = (seat: Seat, npcId: string) => npcBondsOf(server!.orm, seat.memberId).find((b) => b.npcId === npcId)?.affinity ?? 0;

  it('C1: with 3 NPCs saved, saving a 4th is refused until one is released', async () => {
    const t = await table();
    const refs = await refsAtMyPlace(t, t.a);
    expect(Object.keys(refs).sort()).toEqual(['cult-acolyte', 'merchant', 'orphan', 'spy']);

    for (const id of ['orphan', 'merchant', 'spy']) expect((await save(t, t.a, refs[id]!)).status).toBe(201);
    const fourth = await save(t, t.a, refs['cult-acolyte']!);
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ code: 'companion_limit' });
    expect(await companions(t, t.a)).toHaveLength(3);

    expect((await release(t, t.a, refs.merchant!)).status).toBe(200);
    expect((await save(t, t.a, refs['cult-acolyte']!)).status).toBe(201);
    expect((await companions(t, t.a)).map((c) => c.ref).sort()).toEqual([refs.orphan, refs.spy, refs['cult-acolyte']].sort());

    // Another player's list is their own.
    expect(await companions(t, t.b)).toEqual([]);
  });

  it('C1: saving the same NPC twice, an NPC elsewhere, or releasing a non-companion is refused', async () => {
    const t = await table();
    const refs = await refsAtMyPlace(t, t.a);
    expect((await save(t, t.a, refs.orphan!)).status).toBe(201);
    expect((await save(t, t.a, refs.orphan!)).status).toBe(409);
    expect((await release(t, t.a, refs.merchant!)).status).toBe(404);
    expect((await save(t, t.a, 'no-such-ref')).status).toBe(404);

    moveCharacter(server!.orm, t.a.memberId, 'temple', CLOCK);
    const atMarket = await save(t, t.a, refs.merchant!);
    expect(atMarket.status).toBe(404);
    expect(atMarket.body).toMatchObject({ code: 'npc_not_found' });
  });

  it('C2: the main companion is the one with the highest affinity; on a tie, the one saved first', async () => {
    const t = await table();
    const refs = await refsAtMyPlace(t, t.a);
    for (const id of ['merchant', 'orphan', 'spy']) await save(t, t.a, refs[id]!);

    // All 0: merchant was saved first.
    expect((await companions(t, t.a))[0]).toMatchObject({ ref: refs.merchant, role: 'main' });

    raiseAffinity(t.a, 'spy', 4);
    let list = await companions(t, t.a);
    expect(list.map((c) => [c.ref, c.role])).toEqual([
      [refs.spy, 'main'],
      [refs.merchant, 'secondary'],
      [refs.orphan, 'secondary'],
    ]);

    // Tie at 4: merchant (saved before spy) becomes main again.
    raiseAffinity(t.a, 'merchant', 4);
    list = await companions(t, t.a);
    expect(list[0]).toMatchObject({ ref: refs.merchant, role: 'main' });
  });

  it('C3: an affinity change of +15 in one action is rejected and nothing changes', async () => {
    const t = await table();
    raiseAffinity(t.a, 'merchant', 5);
    const r = changeNpcAffinity(server!.orm, t.a.memberId, 'merchant', 15, CLOCK);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('out_of_range');
    expect(bondAffinity(t.a, 'merchant')).toBe(5);
    expect(changeNpcAffinity(server!.orm, t.a.memberId, 'no-such-npc', 3, CLOCK)).toMatchObject({ ok: false, error: { code: 'unknown_npc' } });
  });

  it('C4: grade F at affinity 70 + good karma → SS ทูตสวรรค์; evil karma → SS เทพมารจันทราโลหิต; 69 → still F', async () => {
    const t = await table();
    setKarma(t.a, 45);
    setKarma(t.b, -45);
    setKarma(t.c, 45);
    raiseAffinity(t.a, 'orphan', 70);
    raiseAffinity(t.b, 'orphan', 70);
    raiseAffinity(t.c, 'orphan', 69);

    // F → SS waits for the end of Night.
    expect(evolveNpcsAtPhaseEnd(server!.orm, t.a.memberId, 'AFTERNOON', CLOCK)).toEqual([]);
    expect(npcGradeFor(server!.orm, t.a.memberId, 'orphan')).toBe('F');

    expect(evolveNpcsAtPhaseEnd(server!.orm, t.a.memberId, 'NIGHT', CLOCK)).toEqual([{ npcId: 'orphan', grade: 'SS', form: 'angel' }]);
    expect(evolveNpcsAtPhaseEnd(server!.orm, t.b.memberId, 'NIGHT', CLOCK)).toEqual([{ npcId: 'orphan', grade: 'SS', form: 'blood-moon' }]);
    expect(evolveNpcsAtPhaseEnd(server!.orm, t.c.memberId, 'NIGHT', CLOCK)).toEqual([]);

    expect(npcGradeFor(server!.orm, t.a.memberId, 'orphan')).toBe('SS');
    expect(npcGradeFor(server!.orm, t.b.memberId, 'orphan')).toBe('SS');
    expect(npcGradeFor(server!.orm, t.c.memberId, 'orphan')).toBe('F');
    // Once only.
    expect(evolveNpcsAtPhaseEnd(server!.orm, t.a.memberId, 'NIGHT', CLOCK)).toEqual([]);
  });

  it('C6: grade A with the crisis-aid flag becomes S at the end of the phase; without it stays A', async () => {
    const t = await table();
    expect(markCrisisAid(server!.orm, t.a.memberId, 'spy', CLOCK)).toBe(true);
    expect(evolveNpcsAtPhaseEnd(server!.orm, t.a.memberId, 'MORNING', CLOCK)).toEqual([{ npcId: 'spy', grade: 'S', form: null }]);
    expect(npcGradeFor(server!.orm, t.a.memberId, 'spy')).toBe('S');

    raiseAffinity(t.b, 'spy', 100);
    setKarma(t.b, 100);
    expect(evolveNpcsAtPhaseEnd(server!.orm, t.b.memberId, 'NIGHT', CLOCK)).toEqual([]);
    expect(npcGradeFor(server!.orm, t.b.memberId, 'spy')).toBe('A');
  });

  it('C7: a grade B NPC cannot give a Legendary reward (Common - Rare only); an evolved SS can', async () => {
    const t = await table();
    expect(checkNpcRewardFor(server!.orm, t.a.memberId, 'merchant', 'Legendary')).toMatchObject({ code: 'tier_not_allowed' });
    expect(checkNpcRewardFor(server!.orm, t.a.memberId, 'merchant', 'Common')).toBeNull();
    expect(checkNpcRewardFor(server!.orm, t.a.memberId, 'merchant', 'Rare')).toBeNull();

    expect(checkNpcRewardFor(server!.orm, t.a.memberId, 'orphan', 'Legendary')).toMatchObject({ code: 'tier_not_allowed' });
    setKarma(t.a, 50);
    raiseAffinity(t.a, 'orphan', 70);
    evolveNpcsAtPhaseEnd(server!.orm, t.a.memberId, 'NIGHT', CLOCK);
    expect(checkNpcRewardFor(server!.orm, t.a.memberId, 'orphan', 'Legendary')).toBeNull();
  });

  it('Q-084: names are revealed by grade (F +5, B +9, A +20) and stay revealed in the companion list', async () => {
    const t = await table();
    const refs = await refsAtMyPlace(t, t.a);
    for (const id of ['orphan', 'merchant', 'spy']) await save(t, t.a, refs[id]!);
    raiseAffinity(t.a, 'orphan', 5);
    raiseAffinity(t.a, 'merchant', 8);
    raiseAffinity(t.a, 'spy', 19);
    const byRef = new Map((await companions(t, t.a)).map((c) => [c.ref, c]));
    expect(byRef.get(refs.orphan!)).toMatchObject({ name: npc('orphan').name, nameRevealed: true });
    expect(byRef.get(refs.merchant!)).toMatchObject({ name: npc('merchant').alias, nameRevealed: false });
    expect(byRef.get(refs.spy!)).toMatchObject({ name: npc('spy').alias, nameRevealed: false });
    raiseAffinity(t.a, 'spy', 20);
    expect((await companions(t, t.a)).find((c) => c.ref === refs.spy)).toMatchObject({ name: npc('spy').name, nameRevealed: true });
  });

  it('C8: after a restart (save / load) companions, affinity and grades are the same', async () => {
    const t = await table();
    const refs = await refsAtMyPlace(t, t.a);
    for (const id of ['orphan', 'merchant', 'spy']) await save(t, t.a, refs[id]!);
    setKarma(t.a, -60);
    raiseAffinity(t.a, 'orphan', 70);
    raiseAffinity(t.a, 'merchant', 12);
    markCrisisAid(server!.orm, t.a.memberId, 'spy', CLOCK);
    evolveNpcsAtPhaseEnd(server!.orm, t.a.memberId, 'NIGHT', CLOCK);

    const before = {
      list: await companions(t, t.a),
      bonds: npcBondsOf(server!.orm, t.a.memberId),
      grades: ['orphan', 'merchant', 'spy'].map((id) => npcGradeFor(server!.orm, t.a.memberId, id)),
      refs: await refsAtMyPlace(t, t.a),
    };
    expect(before.grades).toEqual(['SS', 'B', 'S']);

    await server!.close();
    server = await startTestServer(dataDir);
    const again = { ...t, call: (await import('./visibility-fixture.ts')).caller(server) };

    expect(await companions(again, t.a)).toEqual(before.list);
    expect(npcBondsOf(server.orm, t.a.memberId)).toEqual(before.bonds);
    expect(['orphan', 'merchant', 'spy'].map((id) => npcGradeFor(server!.orm, t.a.memberId, id))).toEqual(before.grades);
    expect(await refsAtMyPlace(again, t.a)).toEqual(before.refs);
  });
});
