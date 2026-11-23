import { TurnChange, type RoomEntry, type Scenario } from '@isekai/protocol';
import { SeededRng, type PhaseAction, type ResolutionProposal } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { mockReply } from '../src/ai/providers/mock.ts';
import { applyPhaseActions } from '../src/crossplayer/phase.ts';
import type { TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, contextOf, mockTurnProposal } from '../src/gm/mock-gm.ts';
import { turnChangesOf, type StatSnapshot } from '../src/room/turn-changes.ts';
import { getGameScenario, updateGameScenario } from '../src/scenario/store.ts';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { moveCharacter } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-182: the affinity the AI GM proposes (`effects.affinity`) is stored in npc_bond for that player when the turn
 * applies (the publish transaction), with the existing rules: ±10 per action, -100..100, grade B reveals at its
 * threshold, F / A never by affinity (GEN-170). The player's change log shows the bond word, never the number.
 */

const MARKET = 'market';
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
const NOA_ALIAS = 'เด็กขอทานตาบอดข้างหนึ่ง';

const noEffects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };
function befriend(who: Seat, npcId: string, delta: number): PhaseAction {
  const proposal: ResolutionProposal = {
    actionId: `talk-${who.name}`,
    kind: 'general',
    tags: [],
    opposed: false,
    staminaCost: 3,
    visibility: 'public',
    target: null,
    check: { type: 'none' },
    modifiers: [],
    witnessNpcIds: [],
    repDeltaIfCaught: 0,
    onSuccess: { ...noEffects, affinity: [{ npcId, delta }] },
    onFail: noEffects,
    reason: 'talk',
  };
  return { actorId: who.memberId, proposal, targetPlayer: null, moveTo: null, awareness: 'normal' };
}

describe('GEN-182 change log: the bond word, like conduct', () => {
  const snap = (bonds: NonNullable<StatSnapshot['bonds']>): StatSnapshot => ({ hp: 100, stamina: 30, coins: 20, conduct: 'เป็นกลาง', items: [], statuses: [], bonds });
  const why = { log: [], hazard: new Map<string, number>(), hits: new Map() };

  it('lists a bond only when its word changed (a new bond starts at the word of 0)', () => {
    expect(turnChangesOf('a', snap({}), snap({}), snap({ noa: { name: NOA_ALIAS, word: 'ห่างเหิน' } }), why)).toEqual([]);
    expect(turnChangesOf('a', snap({}), snap({}), snap({ noa: { name: NOA_ALIAS, word: 'คุ้นเคย' } }), why)).toEqual([
      { stat: 'bond', name: NOA_ALIAS, from: 'ห่างเหิน', to: 'คุ้นเคย', reason: expect.any(String) },
    ]);
  });
});

describe('GEN-182 AI GM affinity is stored in npc_bond', { timeout: 60_000 }, () => {
  let dataDir = '';
  let cleanup = () => {};
  let server: RunningServer | undefined;
  const sockets: RoomClient[] = [];

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

  const gameIdOf = (seat: Seat) => (server!.db.prepare('select game_id from member where id = ?').get(seat.memberId) as { game_id: string }).game_id;
  const bond = (who: Seat, npcId: string) =>
    server!.db.prepare('select affinity, name_revealed as revealed from npc_bond where member_id = ? and npc_id = ?').get(who.memberId, npcId) as
      | { affinity: number; revealed: number }
      | undefined;
  const setBond = (who: Seat, npcId: string, affinity: number) =>
    server!.db.prepare('insert into npc_bond (member_id, npc_id, affinity, name_revealed, updated_at) values (?, ?, ?, 0, ?)').run(who.memberId, npcId, affinity, CLOCK);

  /** A started game whose NPCs are the sheet's, all at the market with the three players. */
  async function table(options: Parameters<typeof startTestServer>[1] = {}, humanGm = false): Promise<Table> {
    server = await startTestServer(dataDir, options);
    const t = await startedTable(server, humanGm);
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

  const apply = (t: Table, actions: PhaseAction[]) => {
    const res = applyPhaseActions(server!.orm, gameIdOf(t.a), actions, new SeededRng(1), CLOCK, { assets: server!.assets, day: 1 });
    expect(res.ok, JSON.stringify(res)).toBe(true);
  };

  it('C1 + C5: +10 with Noa is stored for that player only, and is still there after a restart', async () => {
    const t = await table();
    apply(t, [befriend(t.a, 'noa', 10)]);
    expect(bond(t.a, 'noa')?.affinity).toBe(10);
    expect(bond(t.b, 'noa')).toBeUndefined();
    await server!.close();
    server = await startTestServer(dataDir);
    expect(bond(t.a, 'noa')?.affinity).toBe(10);
  });

  it('C2: past the cap the stored value is clamped to 100', async () => {
    const t = await table();
    setBond(t.a, 'noa', 95);
    apply(t, [befriend(t.a, 'noa', 10)]);
    expect(bond(t.a, 'noa')?.affinity).toBe(100);
  });

  it('C3: a grade B NPC reaching its threshold (+9) reveals the name to that player', async () => {
    const t = await table();
    setBond(t.a, 'elena', 8);
    apply(t, [befriend(t.a, 'elena', 1)]);
    expect(bond(t.a, 'elena')).toEqual({ affinity: 9, revealed: 1 });
  });

  it('C4: grade F / A: an affinity change never reveals the name (GEN-170)', async () => {
    const t = await table();
    const gradeA = server!.assets.npcs.find((n) => n.grade === 'A')!;
    const aId = IDS[gradeA.aliases[0]!]!;
    apply(t, [befriend(t.a, 'noa', 10), befriend(t.b, aId, 10)]);
    expect(bond(t.a, 'noa')).toEqual({ affinity: 10, revealed: 0 });
    expect(bond(t.b, aId)).toEqual({ affinity: 10, revealed: 0 });
  });

  it('change log: the turn publish stores it and the player sees the bond word with the alias, never the number or the real name', async () => {
    const provider: AiProvider = {
      id: 'mock',
      ready: () => ({ ok: true }),
      estimateTokens: (text) => Math.ceil(text.length / 3),
      async call(req: AiCallRequest) {
        if (req.output.name !== 'gm_turn_proposal') return mockReply.ok(await cannedGmAnswer(req));
        const ctx = contextOf<TurnContext>(req);
        const proposal = mockTurnProposal(ctx);
        for (const a of proposal.actions) {
          a.check = { type: 'none' };
          if (ctx.actions.find((x) => x.actionId === a.actionId)?.text.includes('noa')) a.onSuccess = { ...a.onSuccess, affinity: [{ npcId: 'noa', delta: 10 }] };
        }
        return { ...mockReply.ok(proposal), model: req.model };
      },
    };
    const t = await table({ aiProvider: provider, ai: loadAiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0', AI_RETRY_DELAY_MS: '0' }) });
    const clients = await Promise.all([t.a, t.b, t.c].map(async (seat) => {
      const c = await openRoom(server!, { token: seat.token });
      sockets.push(c);
      await c.waitFor(isReady);
      return c;
    }));
    for (const [i, c] of clients.entries()) {
      const from = c.messages.length;
      c.action(i === 0 ? 'ยิ้มให้เด็ก noa' : 'มองรอบๆ', 'public');
      expect(await c.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
    }
    const a = clients[0]!;
    await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'changes' && (m.entry.changes ?? []).some((c) => c.stat === 'bond'));
    expect(bond(t.a, 'noa')).toEqual({ affinity: 10, revealed: 0 });
    const changes = a.entries().filter((e: RoomEntry) => e.kind === 'changes').flatMap((e) => e.changes ?? []);
    expect(changes).toContainEqual({ stat: 'bond', name: NOA_ALIAS, from: 'ห่างเหิน', to: 'คุ้นเคย', reason: expect.any(String) });
    for (const c of changes) expect(TurnChange.safeParse(c).success).toBe(true);
    expect(JSON.stringify(changes)).not.toMatch(/โนอา|affinity|"10"/);
    // Nobody else gets A's bond line.
    for (const other of clients.slice(1)) expect(other.entries().flatMap((e) => e.changes ?? []).some((c) => c.stat === 'bond')).toBe(false);
  });

  // GEN-187: the Human GM's affinity by hand goes the same way (changeNpcAffinity), with the bond line in that player's log.
  const gmAdjust = (t: Table, who: Seat, npcId: string, value: number) =>
    t.call('POST', '/api/game/gm/adjust', { token: t.gm!.token, body: { field: 'affinity', memberId: who.memberId, npcId, value, reason: 'GM ปรับเอง' } });
  const enter = async (seat: Seat) => {
    const c = await openRoom(server!, { token: seat.token });
    sockets.push(c);
    await c.waitFor(isReady);
    return c;
  };

  it('GEN-187 C1: the GM moves affinity across a word: that player sees the bond change in the log, nobody else does', async () => {
    const t = await table({}, true);
    const [a, b] = [await enter(t.a), await enter(t.b)];
    const res = await gmAdjust(t, t.a, 'noa', 10);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(bond(t.a, 'noa')).toEqual({ affinity: 10, revealed: 0 });
    await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'changes');
    const changes = a.entries().filter((e) => e.kind === 'changes').flatMap((e) => e.changes ?? []);
    expect(changes).toEqual([{ stat: 'bond', name: NOA_ALIAS, from: 'ห่างเหิน', to: 'คุ้นเคย', reason: expect.any(String) }]);
    for (const c of changes) expect(TurnChange.safeParse(c).success).toBe(true);
    expect(JSON.stringify(changes)).not.toMatch(/โนอา|affinity|"10"/);
    expect(b.entries().some((e) => e.kind === 'changes')).toBe(false);
    // Same word: no line.
    expect((await gmAdjust(t, t.a, 'noa', 11)).status).toBe(200);
    expect(bond(t.a, 'noa')?.affinity).toBe(11);
    expect(a.entries().filter((e) => e.kind === 'changes')).toHaveLength(1);
  });

  it('GEN-187 C2: the GM brings a grade B NPC to its threshold (+9): the name is revealed to that player only', async () => {
    const t = await table({}, true);
    setBond(t.a, 'elena', 8);
    expect((await gmAdjust(t, t.a, 'elena', 9)).status).toBe(200);
    expect(bond(t.a, 'elena')).toEqual({ affinity: 9, revealed: 1 });
    expect(bond(t.b, 'elena')).toBeUndefined();
  });

  it('GEN-187 C3: the GM value stays within -100..100 like GEN-182 (100 is kept, 120 is refused and nothing changes)', async () => {
    const t = await table({}, true);
    setBond(t.a, 'noa', 95);
    expect((await gmAdjust(t, t.a, 'noa', 100)).status).toBe(200);
    expect(bond(t.a, 'noa')?.affinity).toBe(100);
    const bad = await gmAdjust(t, t.a, 'noa', 120);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'invalid_input' });
    expect((await gmAdjust(t, t.a, 'noa', -100)).status).toBe(200);
    expect(bond(t.a, 'noa')?.affinity).toBe(-100);
  });
});
