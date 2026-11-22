import { defaultScenario, SurroundingsResponse } from '@isekai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../src/server.ts';
import { advanceTimeline } from '../src/timeline/store.ts';
import { learnName, locationSnapshot, moveCharacter, setNpcAffinity } from '../src/visibility/store.ts';
import { seesEvent, witnessesOf, type PlaceEvent } from '../src/visibility/views.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

const merchant = defaultScenario().npcs.find((n) => n.id === 'merchant')!; // grade B at the market

describe('visibility layer: who sees what (GEN-050)', { timeout: 60_000 }, () => {
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

  async function table(humanGm = false): Promise<Table> {
    server = await startTestServer(dataDir);
    return startedTable(server, humanGm);
  }

  async function surroundings(t: Table, who: { token: string }) {
    const res = await t.call('GET', '/api/game/surroundings', { token: who.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { raw: JSON.stringify(res.body), view: SurroundingsResponse.parse(res.body) };
  }

  async function playerView(t: Table, who: Seat) {
    const { raw, view } = await surroundings(t, who);
    if (view.view !== 'player') throw new Error(`expected a player view, got ${view.view}`);
    return { raw, view };
  }

  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const gameIdOf = (who: Seat) =>
    (server!.db.prepare('select game_id from member where id = ?').get(who.memberId) as { game_id: string }).game_id;
  const hp = (who: Seat, value: number) => server!.db.prepare('update character set hp = ? where member_id = ?').run(value, who.memberId);

  it('C1: A sees their own name, HP, Stamina and Social Title, and no karma or reputationScore', async () => {
    const t = await table();
    server!.db.prepare('update character set karma = 37, reputation = 15 where member_id = ?').run(t.a.memberId);

    const { raw, view } = await playerView(t, t.a);

    expect(view.you).toMatchObject({
      name: 'ลิน',
      hp: { current: 100, max: 100 },
      stamina: { current: 30, max: 30 },
      socialTitle: 'คนคุ้นหน้า',
    });
    expect(raw).not.toMatch(/karma|reputation/i);
    expect(raw).not.toContain('37');
  });

  it('C2: A sees B at the same place by appearance, injury and title; not B\'s name, HP or Stamina', async () => {
    const t = await table();
    hp(t.b, 30);

    const { raw, view } = await playerView(t, t.a);

    expect(view.place).not.toBeNull();
    const b = view.people.find((p) => p.appearance === t.b.appearance);
    expect(b).toEqual({ ref: expect.any(String), appearance: t.b.appearance, injury: 'บาดเจ็บ', socialTitle: 'คนแปลกหน้า', name: null });
    expect(raw).not.toContain(t.b.name);
    expect(raw).not.toContain(t.b.personality);
    expect(raw).not.toContain(t.b.memberId);
    // A's own character is the only one with numbers.
    expect(view.people.some((p) => p.appearance === t.a.appearance)).toBe(false);
  });

  it('C3: after B introduces themself to A, A sees B\'s name but C still does not', async () => {
    const t = await table();

    learnName(server!.orm, t.a.memberId, t.b.memberId, 'introduced', CLOCK);

    const seenByA = (await playerView(t, t.a)).view.people.find((p) => p.appearance === t.b.appearance);
    expect(seenByA?.name).toBe('ดาริน');
    const byC = await playerView(t, t.c);
    expect(byC.view.people.find((p) => p.appearance === t.b.appearance)?.name).toBeNull();
    expect(byC.raw).not.toContain('ดาริน');
  });

  it('C4: grade B NPC: affinity +8 shows the alias to A, +9 the real name; others still see the alias', async () => {
    const t = await table();
    move(t.a, merchant.locationId);
    move(t.b, merchant.locationId);

    setNpcAffinity(server!.orm, t.a.memberId, merchant, 8, CLOCK);
    let a = await playerView(t, t.a);
    expect(a.view.npcs).toContainEqual({ name: merchant.alias, nameRevealed: false });
    expect(a.raw).not.toContain(merchant.name);

    setNpcAffinity(server!.orm, t.a.memberId, merchant, 9, CLOCK);
    a = await playerView(t, t.a);
    expect(a.view.npcs).toContainEqual({ name: merchant.name, nameRevealed: true });
    expect(a.raw).not.toContain('"affinity"');

    const b = await playerView(t, t.b);
    expect(b.view.npcs).toContainEqual({ name: merchant.alias, nameRevealed: false });
    expect(b.raw).not.toContain(merchant.name);

    // Permanent: a later drop does not hide the name again (Rules Spec §8.1).
    setNpcAffinity(server!.orm, t.a.memberId, merchant, -20, CLOCK);
    expect((await playerView(t, t.a)).view.npcs).toContainEqual({ name: merchant.name, nameRevealed: true });
  });

  it('C5: the Human GM sees every field of every character, karma, reputationScore and place included', async () => {
    const t = await table(true);
    server!.db.prepare('update character set karma = -42, reputation = 33 where member_id = ?').run(t.b.memberId);
    move(t.c, 'forest');

    const { view } = await surroundings(t, t.gm!);

    if (view.view !== 'gm') throw new Error('expected the GM view');
    expect(view.characters.map((c) => c.memberId).sort()).toEqual([t.a.memberId, t.b.memberId, t.c.memberId].sort());
    const b = view.characters.find((c) => c.memberId === t.b.memberId)!;
    expect(b).toMatchObject({ name: 'ดาริน', personality: t.b.personality, karma: -42, reputationScore: 33, socialTitle: 'ผู้ใจบุญ' });
    expect(view.characters.find((c) => c.memberId === t.c.memberId)?.locationId).toBe('forest');
    expect(view.characters.every((c) => typeof c.locationId === 'string')).toBe(true);
  });

  it('C5: players in a game with a Human GM still get the player view', async () => {
    const t = await table(true);
    expect((await surroundings(t, t.a)).view.view).toBe('player');
  });

  it('C7: the injury word others see follows the HP bands (100 ปกติ, 1 สาหัส, 0 หมดสติ)', async () => {
    const t = await table();
    const seen = async () => (await playerView(t, t.a)).view.people.find((p) => p.appearance === t.b.appearance)?.injury;
    hp(t.b, 100);
    expect(await seen()).toBe('ปกติ');
    hp(t.b, 1);
    expect(await seen()).toBe('สาหัส');
    hp(t.b, 0);
    expect(await seen()).toBe('หมดสติ');
  });

  it('C8: A at the market does not see C in the forest, C\'s actions or where C is', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'market');
    move(t.c, 'forest');

    const { raw, view } = await playerView(t, t.a);
    expect(view.place?.id).toBe('market');
    expect(view.people.map((p) => p.appearance)).toEqual([t.b.appearance]);
    expect(raw).not.toContain(t.c.appearance);
    expect(raw).not.toContain('forest');
    expect(raw).not.toContain('ป่า');

    // Actions are seen by who was at the place when they resolved.
    const snapshot = locationSnapshot(server!.orm, gameIdOf(t.a));
    const cInForest: PlaceEvent = { locationId: 'forest', actorMemberId: t.c.memberId, visibility: 'public' };
    const bAtMarket: PlaceEvent = { locationId: 'market', actorMemberId: t.b.memberId, visibility: 'public' };
    expect(seesEvent(t.a.memberId, witnessesOf(cInForest, snapshot))).toBe(false);
    expect(seesEvent(t.c.memberId, witnessesOf(cInForest, snapshot))).toBe(true);
    expect(seesEvent(t.a.memberId, witnessesOf(bAtMarket, snapshot))).toBe(true);
    // A Secret action is seen only by its actor here (being noticed is GEN-060).
    const bSecret: PlaceEvent = { ...bAtMarket, visibility: 'secret' };
    expect(seesEvent(t.a.memberId, witnessesOf(bSecret, snapshot))).toBe(false);
    expect(seesEvent(t.b.memberId, witnessesOf(bSecret, snapshot))).toBe(true);
  });

  it('C9: after C moves to the market A sees C from the next phase, but not what C did in the forest', async () => {
    const t = await table();
    const gameId = gameIdOf(t.a);
    move(t.a, 'market');
    move(t.b, 'market');
    move(t.c, 'forest');
    // Day 1 Morning: C acts in the forest; witnesses are fixed when it resolves.
    const forestWitnesses = witnessesOf({ locationId: 'forest', actorMemberId: t.c.memberId, visibility: 'public' }, locationSnapshot(server!.orm, gameId));

    // C's move resolves; the game goes on to Afternoon.
    move(t.c, 'market');
    advanceTimeline(server!.orm, gameId, { day: 1, phase: 'AFTERNOON' }, CLOCK);

    const { view } = await playerView(t, t.a);
    expect(view.people.map((p) => p.appearance).sort()).toEqual([t.b.appearance, t.c.appearance].sort());
    expect(seesEvent(t.a.memberId, forestWitnesses)).toBe(false);
    const cAtMarket = witnessesOf({ locationId: 'market', actorMemberId: t.c.memberId, visibility: 'public' }, locationSnapshot(server!.orm, gameId));
    expect(seesEvent(t.a.memberId, cAtMarket)).toBe(true);
  });

  it('every character is placed when the game starts, so players at the same start place see each other', async () => {
    const t = await table();
    const { view } = await playerView(t, t.a);
    expect(view.place).toEqual({ id: defaultScenario().locations[0]!.id, name: defaultScenario().locations[0]!.name });
    expect(view.people.map((p) => p.appearance).sort()).toEqual([t.b.appearance, t.c.appearance].sort());
  });

  it('before the start nobody is placed: no place, nobody around', async () => {
    server = await startTestServer(dataDir);
    const { caller, CREATE_CODE, LIN } = await import('./visibility-fixture.ts');
    const call = caller(server);
    const created = await call('POST', '/api/games', {
      body: { createCode: CREATE_CODE, gameName: 'เกม', mode: 'online', humanGm: false, name: 'นก', pin: '1234' },
    });
    const token = (created.body as { token: string }).token;
    await call('POST', '/api/game/character', { token, body: LIN });
    const res = await call('GET', '/api/game/surroundings', { token });
    expect(SurroundingsResponse.parse(res.body)).toMatchObject({ view: 'player', place: null, people: [], npcs: [] });
  });
});
