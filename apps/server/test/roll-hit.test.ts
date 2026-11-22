import { GameLogResponse, GmConsoleResponse, HitView, RollView, RoomServerMessage, type RoomEntry } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { gameStatus } from '../src/db/schema.ts';
import { getGameScenario } from '../src/scenario/store.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { hitOf, rollViewOf } from '../src/gm/roll-view.ts';
import type { RunningServer } from '../src/server.ts';
import { presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { heldTurn } from './gm-console-client.ts';
import { CLOCK, LIN, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * Q-229 (GEN-105 C1, C2): the roll of your own action (a d20, the difficulty as a word, factor arrows, no DC) and the
 * "hit" card for a player another player cost something, over the real play room with the Mock GM.
 */
describe('Q-229 roll and hit entries', { timeout: 60_000 }, () => {
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

  async function enter(seat: { token: string }): Promise<RoomClient> {
    const client = await openRoom(server!, { token: seat.token });
    sockets.push(client);
    await client.waitFor(isReady);
    return client;
  }

  async function send(client: RoomClient, text: string) {
    const from = client.messages.length;
    client.action(text, 'public');
    expect(await client.waitFor((m) => m.type === 'action_accepted' || m.type === 'action_rejected', from)).toEqual({ type: 'action_accepted' });
  }

  const nextTurn = (m: RoomServerMessage) => m.type === 'room' && m.turn === 2 && m.status === 'collecting';
  const refOf = (seat: Seat) => presenceOf(server!.orm, seat.memberId)!.ref;

  /** A hits B publicly (a lethal blow), C waits; everyone has their turn-1 entries when turn 2 opens. */
  async function playHit(): Promise<{ t: Table; a: RoomClient; b: RoomClient; c: RoomClient }> {
    server = await startTestServer(dataDir, { ai: loadAiConfig({ AI_PROVIDER: 'mock' }) });
    const t = await startedTable(server, false);
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await send(a, `ฟาดเขา [mock:harm=${refOf(t.b)}]`);
    await send(b, 'มองรอบๆ');
    await send(c, 'นั่งพัก');
    await a.waitFor(nextTurn);
    await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'hit');
    return { t, a, b, c };
  }

  const entriesOf = (c: RoomClient, kind: RoomEntry['kind']) => c.entries().filter((e) => e.kind === kind);

  it('C1: the player who was hit gets a hit entry with how they know the actor and what changed; nobody else does', async () => {
    const { t, a, b, c } = await playHit();
    const [hit] = entriesOf(b, 'hit');
    expect(HitView.parse(hit!.hit)).toEqual({ actor: LIN.appearance, changes: [{ stat: 'hp', delta: expect.any(Number) }] });
    expect(hit!.hit!.changes[0]).toMatchObject({ stat: 'hp' });
    expect((hit!.hit!.changes[0] as { delta: number }).delta).toBeLessThan(0);
    expect(hit!.place).toBeNull();
    for (const other of [a, c]) expect(entriesOf(other, 'hit')).toEqual([]);
    // Every frame (hit and roll included) passes the contract's room schema.
    for (const client of [a, b, c]) for (const raw of client.raw) expect(RoomServerMessage.safeParse(JSON.parse(raw)).success, raw).toBe(true);

    // The log and a reconnect replay give the same card back.
    const log = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.b.token })).body);
    expect(log.entries.filter((e) => e.kind === 'hit')).toEqual([hit]);
    expect(GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.c.token })).body).entries.some((e) => e.kind === 'hit')).toBe(false);
  });

  it('C2: an own action with a roll shows the d20, the difficulty word and factor arrows, never a DC or total', async () => {
    const { b } = await playHit();
    // B's own action (a plain DC 11 check from the Mock GM) comes back with its roll on B's narration only.
    const narration = entriesOf(b, 'narration')[0]!;
    const roll = RollView.parse(narration.roll);
    expect(roll.difficulty).toBe('ปานกลาง');
    expect(roll.d20).toBeGreaterThanOrEqual(1);
    expect(['success', 'failure', 'critical_success', 'critical_failure']).toContain(roll.outcome);
    const raw = JSON.stringify(narration);
    expect(raw).not.toMatch(/"(dc|total|modifier|modifiers|karma|reputation|affinity)"/);
    for (const e of b.entries()) if (e.kind !== 'narration') expect(e.roll).toBeUndefined();
  });

  it('the Human GM console shows every number of the held turn\'s rolls and the curses on NPCs; players never get them', async () => {
    server = await startTestServer(dataDir, { ai: loadAiConfig({ AI_PROVIDER: 'mock' }) });
    const t = await startedTable(server, true);
    const tgm = t.gm!.token;
    const gameId = (server.db.prepare('select game_id as id from member where id = ?').get(t.a.memberId) as { id: string }).id;
    const npc = getGameScenario(server.orm, gameId)!.npcs[0]!;
    server.orm.insert(gameStatus).values({ gameId, holderKind: 'npc', holderId: npc.id, source: 'Venom of Despair', label: 'หวาดกลัว', value: -3, fromTurn: 0, untilTurn: 3, castBy: t.a.memberId, updatedAt: CLOCK }).run();
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    for (const x of [a, b, c]) await send(x, 'มองรอบๆ');

    const pending = await heldTurn(t.call, tgm);
    expect(pending.checks).toHaveLength(3);
    for (const check of pending.checks!) {
      expect(check).toMatchObject({ dc: 11, visibility: 'public', text: 'มองรอบๆ' });
      expect(check.total).toBe(check.d20 + check.modifiers.reduce((sum, m) => sum + m.value, 0));
    }
    const consoleView = GmConsoleResponse.parse((await t.call('GET', '/api/game/gm/console', { token: tgm })).body);
    expect(consoleView.npcs).toEqual([{ npcId: npc.id, name: npc.name, curses: [{ label: 'หวาดกลัว', source: 'Venom of Despair', value: -3, turnsLeft: expect.any(Number) }] }]);

    // Approved: the players get their rolls as words; no number of the GM's view reaches them.
    await t.call('POST', '/api/game/gm/turn/approve', { token: tgm });
    await a.waitFor(nextTurn);
    await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'narration');
    expect(JSON.stringify(a.entries())).not.toMatch(/"(dc|total|modifiers?)"/);
    expect(a.entries().find((e) => e.kind === 'narration')!.roll).toMatchObject({ difficulty: 'ปานกลาง' });
  });

  it('a roll shows each factor as an arrow with a label, and fate only as a question mark', () => {
    const log = {
      check: {
        dc: 14,
        d20: 12,
        modifiers: [
          { source: 'skill', ref: 's1', value: 3 },
          { source: 'item', ref: 'unknown', value: -1 },
          { source: 'karma', align: 'light', value: 4 },
          { source: 'stat', value: 0 },
          { source: 'weather', ref: 'Rain', value: -2 },
        ],
        modifierSum: 4,
        modifierTotal: 4,
        total: 16,
        margin: 2,
      },
      degree: 'success',
    } as unknown as Parameters<typeof rollViewOf>[0];
    expect(rollViewOf(log, (ref) => (ref === 's1' ? 'Luminous Strike' : undefined))).toEqual({
      d20: 12,
      difficulty: 'ยาก',
      outcome: 'success',
      factors: [
        { label: 'Luminous Strike', kind: 'skill', dir: 'up' },
        { label: 'ไอเทม', kind: 'item', dir: 'down' },
        { label: 'โชคชะตา', kind: 'fate', dir: 'unknown' },
        { label: 'สภาพอากาศ', kind: 'weather', dir: 'down' },
      ],
    });
    expect(rollViewOf({ ...log, check: null }, () => undefined)).toBeNull();
  });

  it('a hit lists HP, taken items and curses; a Secret act the target did not notice has no actor; an act that cost nothing is no hit', () => {
    const outcome = (over: object) =>
      ({
        status: 'resolved',
        actorId: 'a',
        target: { playerId: 'b', hp: { before: 20, damage: 8, heal: 0, after: 12 }, itemsLost: ['i1'], itemsGained: [], knowsActor: true, ...over },
      }) as unknown as Parameters<typeof hitOf>[0];
    expect(hitOf(outcome({}), 'หญิงผ้าคลุมเทา', () => 'Dagger', ['หวาดกลัว'])).toEqual({
      memberId: 'b',
      hit: { actor: 'หญิงผ้าคลุมเทา', changes: [{ stat: 'hp', delta: -8 }, { stat: 'item_lost', name: 'Dagger' }, { stat: 'status', name: 'หวาดกลัว' }] },
    });
    expect(hitOf(outcome({ knowsActor: false }), 'x', () => 'Dagger', [])!.hit.actor).toBeNull();
    expect(hitOf(outcome({ hp: { before: 20, damage: 0, heal: 5, after: 20 }, itemsLost: [] }), 'x', () => '', [])).toBeNull();
  });
});
