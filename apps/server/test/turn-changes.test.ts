import { GameLogResponse, TurnChange, type RoomEntry } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.ts';
import { character } from '../src/db/schema.ts';
import { actionCausesOf, turnChangesOf, type StatSnapshot } from '../src/room/turn-changes.ts';
import type { RunningServer } from '../src/server.ts';
import { forbiddenKeysIn } from '../src/visibility/guard.ts';
import { moveCharacter, presenceOf } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { heldTurn } from './gm-console-client.ts';
import { isReady, openRoom, type RoomClient } from './room-client.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

const snap = (over: Partial<StatSnapshot> = {}): StatSnapshot => ({ hp: 100, stamina: 30, coins: 20, conduct: 'เป็นกลาง', items: [], statuses: [], ...over });
const nobody = { log: [], hazard: new Map<string, number>(), hits: new Map() };

/** GEN-114: the player's private log of what changed each turn, from the server's own before / after. */
describe('GEN-114 per-turn changes: the pure part', () => {
  it('C3: nothing changed lists nothing, not a pile of zeros', () => {
    expect(turnChangesOf('a', snap(), snap(), snap(), nobody)).toEqual([]);
  });

  it('C2: several changes are all listed, and per stat they add up to the real difference', () => {
    const s0 = snap();
    const s1 = snap({ coins: 15 });
    const s2 = snap({ hp: 90, stamina: 27, coins: 15, statuses: ['หวาดกลัว'], items: ['Dagger'] });
    const hits = new Map([['a', [{ stat: 'hp' as const, delta: -10 }, { stat: 'status' as const, name: 'หวาดกลัว' }]]]);
    const changes = turnChangesOf('a', s0, s1, s2, { ...nobody, hits });
    const sum = (stat: string) => changes.reduce((n, c) => n + (c.stat === stat && 'delta' in c ? c.delta : 0), 0);
    expect([sum('hp'), sum('stamina'), sum('coins')]).toEqual([-10, -3, -5]);
    expect(changes).toContainEqual({ stat: 'hp', delta: -10, reason: 'ถูกโจมตี' });
    expect(changes).toContainEqual({ stat: 'status_gained', name: 'หวาดกลัว', reason: 'ถูกคนอื่นลงมือ' });
    expect(changes).toContainEqual({ stat: 'item_gained', name: 'Dagger', reason: expect.any(String) });
    for (const c of changes) expect(TurnChange.safeParse(c).success).toBe(true);
  });

  it('C5: karma is only ever the status bar word, only when the word changed, never a number', () => {
    expect(turnChangesOf('a', snap(), snap(), snap({ conduct: 'เป็นกลาง' }), nobody)).toEqual([]);
    const changes = turnChangesOf('a', snap(), snap(), snap({ conduct: 'ใจดี' }), nobody);
    expect(changes).toEqual([{ stat: 'conduct', from: 'เป็นกลาง', to: 'ใจดี', reason: expect.any(String) }]);
    expect(JSON.stringify(changes)).not.toMatch(/karma|reputation|affinity|"dc"/);
  });

  it('rest, drowsy and hazard explain their own part of the Stamina change', () => {
    const log = [{ type: 'recovered', at: { day: 1, phase: 'EOSORIA', turn: 1 }, playerId: 'a', kind: 'day_rest', site: null, stamina: { before: 10, gain: 6, after: 16 }, hp: { before: 100, gain: 0, after: 100 } }] as never;
    const changes = turnChangesOf('a', snap({ stamina: 10 }), snap({ stamina: 10 }), snap({ stamina: 16 }), { ...nobody, log });
    expect(changes).toEqual([{ stat: 'stamina', delta: 6, reason: 'พักผ่อน' }]);
    const hazard = turnChangesOf('a', snap(), snap(), snap({ stamina: 20 }), { ...nobody, hazard: new Map([['a', 10]]) });
    expect(hazard).toEqual([{ stat: 'stamina', delta: -10, reason: 'พื้นที่อันตราย' }]);
  });
});

/** GEN-124: the resolver says why a player's own HP / Stamina moved (attack, skill) instead of the generic text. */
describe('GEN-124 specific reasons from the resolver', () => {
  const GENERIC = 'การกระทำในเทิร์นนี้';
  const sumOf = (cs: readonly { stat: string }[], stat: string) => cs.reduce((n, c) => n + (c.stat === stat && 'delta' in c ? (c as { delta: number }).delta : 0), 0);
  const outcome = (over: Record<string, unknown>) => ({ status: 'resolved', actorId: 'a', actionId: 'x', target: null, log: { stamina: { net: 5 }, hp: { actor: { before: 100, after: 100 }, target: null }, tagging: undefined }, ...over }) as never;

  it('C1: an attack on an enemy names the attack for the actor\'s Stamina and HP', () => {
    const causes = actionCausesOf([outcome({ target: { playerId: 'b' } })], () => undefined);
    const hpCause = { stat: 'hp' as const, delta: -4, kind: 'attack' as const };
    const withHp = new Map([['a', [...(causes.get('a') ?? []), hpCause]]]);
    const changes = turnChangesOf('a', snap(), snap(), snap({ hp: 96, stamina: 25 }), { ...nobody, causes: withHp });
    expect(changes).toContainEqual({ stat: 'stamina', delta: -5, reason: 'โจมตีศัตรู' });
    expect(changes).toContainEqual({ stat: 'hp', delta: -4, reason: 'โจมตีศัตรู' });
    expect(JSON.stringify(changes)).not.toContain(GENERIC);
  });

  it('C2: a skill that costs Stamina is named', () => {
    const tagging = { activated: [{ ref: 'sk1', stamina: 3, usesToday: 1 }] };
    const causes = actionCausesOf([outcome({ log: { stamina: { net: 5 }, hp: { actor: { before: 100, after: 100 }, target: null }, tagging } })], (id) => (id === 'sk1' ? 'ลูกไฟ' : undefined));
    const changes = turnChangesOf('a', snap(), snap(), snap({ stamina: 22 }), { ...nobody, causes });
    expect(changes).toContainEqual({ stat: 'stamina', delta: -3, reason: 'ใช้ทักษะ ลูกไฟ' });
    expect(sumOf(changes, 'stamina')).toBe(-8);
  });

  it('C3: no known reason keeps the old generic text', () => {
    expect(turnChangesOf('a', snap(), snap(), snap({ stamina: 25 }), nobody)).toEqual([{ stat: 'stamina', delta: -5, reason: GENERIC }]);
  });

  it('C4: reasons never explain more than really changed; the sums stay equal to the status bar', () => {
    const causes = new Map([['a', [{ stat: 'stamina' as const, delta: -9, kind: 'attack' as const }]]]);
    const changes = turnChangesOf('a', snap(), snap(), snap({ stamina: 27 }), { ...nobody, causes });
    expect(sumOf(changes, 'stamina')).toBe(-3);
    expect(changes).toEqual([{ stat: 'stamina', delta: -3, reason: 'โจมตีศัตรู' }]);
  });
});

describe('GEN-114 per-turn changes over the real play room', { timeout: 60_000 }, () => {
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

  const nextTurn = (m: { type: string }) => m.type === 'room' && (m as { turn?: number; status?: string }).turn === 2 && (m as { status?: string }).status === 'collecting';
  const refOf = (seat: Seat) => presenceOf(server!.orm, seat.memberId)!.ref;
  const changesOf = (c: RoomClient): RoomEntry[] => c.entries().filter((e) => e.kind === 'changes');
  const sumOf = (entries: RoomEntry[], stat: string) => entries.flatMap((e) => e.changes ?? []).reduce((n, c) => n + (c.stat === stat && 'delta' in c ? c.delta : 0), 0);
  const row = (id: string) => server!.orm.select().from(character).where(eq(character.memberId, id)).get()!;

  async function table(humanGm: boolean): Promise<Table> {
    server = await startTestServer(dataDir, { ai: loadAiConfig({ AI_PROVIDER: 'mock' }) });
    return startedTable(server, humanGm);
  }

  it('C1: a trip to another zone puts Stamina -3 with its reason in your log at once, equal to the real change', async () => {
    const t = await table(false);
    expect(moveCharacter(server!.orm, t.a.memberId, 'น้ำพุกลางเมือง', CLOCK)).toBe(true);
    const a = await enter(t.a);
    const before = row(t.a.memberId).stamina;
    const from = a.messages.length;
    a.send({ type: 'move', to: 'ป่า' });
    await a.waitFor((m) => m.type === 'move_accepted' || m.type === 'move_rejected', from);
    const entry = await a.waitFor((m) => m.type === 'entry' && m.entry.kind === 'changes', from);
    const changes = entry.type === 'entry' ? entry.entry.changes : [];
    expect(changes).toEqual([{ stat: 'stamina', delta: -3, reason: 'เดินทางข้ามโซน' }]);
    expect(row(t.a.memberId).stamina - before).toBe(-3);
  });

  it('C2 + C4 + C6: one played turn, every change is listed and adds up to the DB; others never see it; a reload brings it back', async () => {
    const t = await table(false);
    const start = Object.fromEntries([t.a, t.b, t.c].map((s) => [s.memberId, row(s.memberId)]));
    const [a, b, c] = [await enter(t.a), await enter(t.b), await enter(t.c)];
    await send(a, `ฟาดเขา [mock:harm=${refOf(t.b)}]`);
    await send(b, 'มองรอบๆ');
    await send(c, 'นั่งพัก');
    await a.waitFor(nextTurn);
    await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'hit');
    await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'changes');

    for (const [seat, client] of [[t.a, a], [t.b, b], [t.c, c]] as const) {
      const mine = changesOf(client);
      const now = row(seat.memberId);
      const was = start[seat.memberId]!;
      expect(mine.every((e) => e.text !== '')).toBe(true);
      expect([sumOf(mine, 'hp'), sumOf(mine, 'stamina'), sumOf(mine, 'coins')]).toEqual([now.hp - was.hp, now.stamina - was.stamina, now.coins - was.coins]);
      for (const e of mine) for (const ch of e.changes ?? []) expect(TurnChange.safeParse(ch).success).toBe(true);
    }
    // GEN-124: A attacked B, so A's Stamina cost says so, not the generic text.
    expect(changesOf(a).flatMap((e) => e.changes ?? [])).toContainEqual({ stat: 'stamina', delta: expect.any(Number), reason: 'โจมตีศัตรู' });
    // B was hit: the hp loss is in B's own log and says why.
    expect(changesOf(b).flatMap((e) => e.changes ?? [])).toContainEqual({ stat: 'hp', delta: expect.any(Number), reason: 'ถูกโจมตี' });
    // C4: nobody gets another player's entry (each only their own character's name), not live and not from the log.
    for (const [seat, client] of [[t.a, a], [t.b, b], [t.c, c]] as const) {
      const log = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: seat.token })).body);
      const names = new Set(log.entries.filter((e) => e.kind === 'changes').map((e) => e.text));
      expect(names.size).toBeLessThanOrEqual(1);
      // C6: reload = the same entries as live.
      expect(log.entries.filter((e) => e.kind === 'changes')).toEqual(changesOf(client));
    }
    const a2 = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.a.token })).body).entries.filter((e) => e.kind === 'changes');
    const b2 = GameLogResponse.parse((await t.call('GET', '/api/game/log', { token: t.b.token })).body).entries.filter((e) => e.kind === 'changes');
    expect(a2.every((e) => !b2.some((x) => x.seq === e.seq))).toBe(true);
    expect(JSON.stringify(changesOf(a))).not.toMatch(/karma|reputation|affinity|"dc"/);
  });

  it('C4: the Human GM sees everyone\'s log (named), players only their own', async () => {
    const t = await table(true);
    const [gm, a, b, c] = [await enter(t.gm!), await enter(t.a), await enter(t.b), await enter(t.c)];
    await send(a, `ฟาดเขา [mock:harm=${refOf(t.b)}]`);
    await send(b, 'มองรอบๆ');
    await send(c, 'นั่งพัก');
    await heldTurn(t.call, t.gm!.token);
    const approve = await t.call('POST', '/api/game/gm/turn/approve', { token: t.gm!.token });
    expect(approve.status).toBeLessThan(300);
    await a.waitFor(nextTurn);
    await b.waitFor((m) => m.type === 'entry' && m.entry.kind === 'changes');
    const gmNames = new Set(changesOf(gm).map((e) => e.text));
    expect(gmNames.size).toBeGreaterThanOrEqual(2);
    for (const player of [a, b, c]) expect(new Set(changesOf(player).map((e) => e.text)).size).toBeLessThanOrEqual(1);
  });
});
