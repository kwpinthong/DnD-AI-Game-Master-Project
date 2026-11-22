import { GameTimelineResponse } from '@isekai/protocol';
import { ReplayRng, SeededRng, type PhaseAction, type PlayerEffects, type PlayerTargeting, type ResolutionProposal } from '@isekai/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPhaseActions, crossPlayerState, noticesFor, type PhaseEventRecord } from '../src/crossplayer/phase.ts';
import { heldItemsOf } from '../src/crossplayer/items.ts';
import type { RunningServer } from '../src/server.ts';
import { advanceTimeline } from '../src/timeline/store.ts';
import { moveCharacter, presenceOf, setPlayerBond } from '../src/visibility/store.ts';
import { makeTempDir } from './helpers.ts';
import { CLOCK, startedTable, startTestServer, type Seat, type Table } from './visibility-fixture.ts';

/**
 * GEN-060 on the server: the functions the AI GM phase loop (GEN-057) calls. They read the game
 * from the database, run the cross-player rules, write the result in one transaction and give each
 * player only what they may know (through the GEN-050 visibility layer).
 */

const none: PlayerEffects = { damage: null, heal: null, takeItem: null, giveItem: null };

function proposal(actionId: string, patch: Partial<ResolutionProposal> = {}): ResolutionProposal {
  const noEffects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };
  return {
    actionId,
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
    onSuccess: noEffects,
    onFail: noEffects,
    reason: 'test action',
    ...patch,
  };
}

const targeting = (player: string, patch: Partial<PlayerTargeting> & Pick<PlayerTargeting, 'intent'>): PlayerTargeting => ({
  player,
  reachRef: null,
  defenseRef: null,
  perceptionRef: null,
  onSuccess: none,
  onFail: none,
  ...patch,
});

const idle = (who: Seat): PhaseAction => ({ actorId: who.memberId, proposal: proposal(`idle-${who.name}`), targetPlayer: null, moveTo: null, awareness: 'normal' });
const goTo = (who: Seat, locationId: string): PhaseAction => ({ ...idle(who), proposal: proposal(`move-${who.name}`), moveTo: locationId });

function steal(thief: Seat, mark: Seat, visibility: 'public' | 'secret', itemId = 'item-purse'): PhaseAction {
  return {
    actorId: thief.memberId,
    proposal: proposal('steal', {
      kind: 'complex',
      opposed: true,
      staminaCost: 6,
      tags: ['stealth'],
      visibility,
      check: { type: 'pvp' },
      modifiers: [{ source: 'stat' }],
      repDeltaIfCaught: -10,
      onSuccess: { ...proposal('x').onSuccess, repDelta: -5 },
    }),
    targetPlayer: targeting(mark.memberId, { intent: 'steal', onSuccess: { ...none, takeItem: itemId } }),
    moveTo: null,
    awareness: 'normal',
  };
}

function hit(attacker: Seat, victim: Seat): PhaseAction {
  return {
    actorId: attacker.memberId,
    proposal: proposal('hit', { kind: 'exertion', staminaCost: 8, tags: ['physical'], check: { type: 'pvp' }, modifiers: [{ source: 'stat' }] }),
    targetPlayer: targeting(victim.memberId, { intent: 'harm', onSuccess: { ...none, damage: 'light' } }),
    moveTo: null,
    awareness: 'normal',
  };
}

describe('cross-player actions on the server (GEN-060)', { timeout: 60_000 }, () => {
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

  async function table(humanGm = false): Promise<Table & { gameId: string }> {
    server = await startTestServer(dataDir);
    const t = await startedTable(server, humanGm);
    const gameId = (server.db.prepare('select game_id from member where id = ?').get(t.a.memberId) as { game_id: string }).game_id;
    return { ...t, gameId };
  }

  const move = (who: Seat, locationId: string) => expect(moveCharacter(server!.orm, who.memberId, locationId, CLOCK)).toBe(true);
  const stats = (who: Seat) =>
    server!.db.prepare('select hp, stamina, reputation, karma from character where member_id = ?').get(who.memberId) as {
      hp: number;
      stamina: number;
      reputation: number;
      karma: number;
    };
  const dbDump = () =>
    JSON.stringify(
      ['character', 'character_presence', 'item_holder', 'character_loot', 'known_name'].map((t) => server!.db.prepare(`select * from ${t} order by rowid`).all()),
    );

  /** B chose a purse in the loot step (GEN-048); A chose a lockpick. */
  function giveLoot(who: Seat, item: { id: string; name: string }) {
    const trait = (label: string, scope: string, value: number) => ({ label, description: label, scope, value });
    const option = (id: string, kind: 'item' | 'skill', name: string) => ({ id, kind, name, description: name, tier: 'Common', buffType: 'Qualitative', effect: null });
    const chosen = {
      strength: trait('ช่างฝีมือ', 'craft', 2),
      weakness: trait('ไม่ศรัทธา', 'faith', -2),
      skill: option(`skill-of-${item.id}`, 'skill', 'ทักษะ'),
      item: option(item.id, 'item', item.name),
    };
    server!.db
      .prepare('insert into character_loot (member_id, offer_json, chosen_json, rerolls_used, updated_at) values (?, null, ?, 0, ?)')
      .run(who.memberId, JSON.stringify(chosen), CLOCK);
  }

  function apply(t: { gameId: string }, actions: PhaseAction[], dice: number[]) {
    const result = applyPhaseActions(server!.orm, t.gameId, actions, new ReplayRng(dice), CLOCK);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
    return result;
  }

  const notices = (t: { gameId: string }, who: Seat, events: readonly PhaseEventRecord[]) => noticesFor(server!.orm, t.gameId, who.memberId, events);

  it('C1: a Public steal moves the item from B to A and B is told what the thief looks like', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'market');
    giveLoot(t.a, { id: 'item-lockpick', name: 'กิ๊บสะเดาะกุญแจ' });
    giveLoot(t.b, { id: 'item-purse', name: 'ถุงเงินหนังวัว' });

    // Seats A 0, B 1, C 2. Priority A 15 + 6, B 5 + 6, C 1 + 6 -> A first; A d20 14 vs DC 11.
    const result = apply(t, [steal(t.a, t.b, 'public'), idle(t.b), idle(t.c)], [15, 5, 1, 14]);

    expect(heldItemsOf(server!.orm, t.gameId, t.a.memberId).map((i) => i.id).sort()).toEqual(['item-lockpick', 'item-purse']);
    expect(heldItemsOf(server!.orm, t.gameId, t.b.memberId)).toEqual([]);
    expect(crossPlayerState(server!.orm, t.gameId).players[t.a.memberId]!.items.map((i) => i.id).sort()).toEqual(['item-lockpick', 'item-purse']);
    expect(stats(t.a)).toMatchObject({ stamina: 24, reputation: -5 });

    const told = notices(t, t.b, result.events).filter((n) => n.kind === 'affected');
    expect(told).toEqual([
      expect.objectContaining({ kind: 'affected', actionId: 'steal', itemsLost: [{ id: 'item-purse', name: 'ถุงเงินหนังวัว' }], by: expect.objectContaining({ appearance: t.a.appearance, name: null }) }),
    ]);
    // The real name is not given until B knows it.
    expect(JSON.stringify(notices(t, t.b, result.events))).not.toContain(t.a.name);
  });

  it('C2: a target at another place is refused (no_target); B hears nothing', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'forest');
    const before = stats(t.b);

    const result = apply(t, [hit(t.a, t.b), idle(t.c)], [15, 1]);

    expect(result.events.find((e) => e.outcome.actorId === t.a.memberId)!.outcome).toMatchObject({ status: 'no_target', reason: 'not_same_place' });
    expect(stats(t.b)).toEqual(before);
    expect(stats(t.a).stamina).toBe(27);
    expect(notices(t, t.a, result.events)).toContainEqual(expect.objectContaining({ kind: 'own_action', actionId: 'hit', status: 'no_target', reason: 'not_same_place' }));
    expect(notices(t, t.b, result.events)).toEqual([]);
  });

  it('C3: a Secret steal B does not notice: B learns the item is gone but not who; Reputation stays', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'market');
    giveLoot(t.b, { id: 'item-purse', name: 'ถุงเงินหนังวัว' });

    // A 15 first; A d20 14 vs DC 11; B observes 10 <= 14.
    const result = apply(t, [steal(t.a, t.b, 'secret'), idle(t.b)], [15, 5, 14, 10]);

    expect(heldItemsOf(server!.orm, t.gameId, t.a.memberId).map((i) => i.id)).toEqual(['item-purse']);
    expect(stats(t.a).reputation).toBe(0);
    const told = notices(t, t.b, result.events).filter((n) => n.kind === 'affected');
    expect(told).toEqual([expect.objectContaining({ itemsLost: [{ id: 'item-purse', name: 'ถุงเงินหนังวัว' }], by: null, noticed: false })]);
    expect(JSON.stringify(told)).not.toContain(t.a.appearance);
  });

  it('C4: B notices the Secret: B sees A (by name if B knows it) and A is caught (Reputation -10)', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'market');
    giveLoot(t.b, { id: 'item-purse', name: 'ถุงเงินหนังวัว' });
    // GEN-067: B sees A's real name because they are allies at relationship > +9.
    setPlayerBond(server!.orm, t.b.memberId, t.a.memberId, { alliance: true, relationship: 10 }, CLOCK);

    const result = apply(t, [steal(t.a, t.b, 'secret'), idle(t.b)], [15, 5, 14, 16]);

    expect(stats(t.a).reputation).toBe(-10);
    expect(heldItemsOf(server!.orm, t.gameId, t.b.memberId).map((i) => i.id)).toEqual(['item-purse']);
    const told = notices(t, t.b, result.events).filter((n) => n.kind === 'affected');
    expect(told).toEqual([expect.objectContaining({ noticed: true, itemsLost: [], by: expect.objectContaining({ appearance: t.a.appearance, name: t.a.name }) })]);
  });

  it('C5: the server order decides whether B is hit before moving away, and moves are written', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'market');

    // B first (A 6 + 6 = 12 < B 9 + 6 = 15): B leaves, A has no target.
    const first = apply(t, [hit(t.a, t.b), goTo(t.b, 'temple')], [6, 9]);
    expect(first.log.order.order).toEqual([t.b.memberId, t.a.memberId]);
    expect(presenceOf(server!.orm, t.b.memberId)?.locationId).toBe('temple');
    expect(stats(t.b).hp).toBe(100);

    // A first (15 + 5 = 20 > 9 + 5 = 14): d20 14 vs DC 11, margin 3 -> 8 + 1 = 9 damage, then B still moves.
    move(t.b, 'market');
    apply(t, [hit(t.a, t.b), goTo(t.b, 'temple')], [15, 9, 14]);
    expect(stats(t.b).hp).toBe(91);
    expect(presenceOf(server!.orm, t.b.memberId)?.locationId).toBe('temple');
  });

  it('C5: a move to a place the scenario does not have is refused and nothing changes', async () => {
    const t = await table();
    const before = dbDump();
    const result = applyPhaseActions(server!.orm, t.gameId, [goTo(t.b, 'atlantis')], new SeededRng(3), CLOCK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.objectContaining({ code: 'unknown_location', path: 'moveTo', action: 0 })]);
    expect(dbDump()).toBe(before);
  });

  it('C6: same stats and seed give the same order, recorded in the log', async () => {
    const t = await table();
    const actions = [idle(t.a), idle(t.b), idle(t.c)];
    const first = applyPhaseActions(server!.orm, t.gameId, actions, new SeededRng(11), CLOCK);
    if (!first.ok) throw new Error('expected ok');
    // Undo the Stamina spent so the second run starts from the same stats.
    server!.db.prepare('update character set stamina = 30').run();
    const second = applyPhaseActions(server!.orm, t.gameId, actions, new SeededRng(11), CLOCK);
    if (!second.ok) throw new Error('expected ok');
    expect(second.log.order).toEqual(first.log.order);
    expect(first.log.order.priorities).toHaveLength(3);
  });

  it('C7: C at another place gets no notice or event of what happens between A and B', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'market');
    move(t.c, 'forest');
    giveLoot(t.b, { id: 'item-purse', name: 'ถุงเงินหนังวัว' });

    const result = apply(t, [steal(t.a, t.b, 'public'), hit(t.b, t.a), idle(t.c)], [15, 5, 1, 14, 14]);

    expect(notices(t, t.c, result.events).filter((n) => n.kind !== 'own_action')).toEqual([]);
    for (const event of result.events.filter((e) => e.outcome.actorId !== t.c.memberId)) {
      expect(event.witnesses).not.toContain(t.c.memberId);
    }
    // Once C is at the market too, C sees the Public action happen (by appearance only).
    move(t.c, 'market');
    const seen = apply(t, [hit(t.a, t.b), idle(t.c)], [15, 1, 14]).events;
    expect(notices(t, t.c, seen)).toContainEqual(
      expect.objectContaining({
        kind: 'witnessed',
        actionId: 'hit',
        actor: expect.objectContaining({ appearance: t.a.appearance, name: null }),
        target: expect.objectContaining({ appearance: t.b.appearance, name: null }),
      }),
    );
  });

  it('C8: targeting an unconscious player or an unknown id is refused and nothing changes', async () => {
    const t = await table();
    move(t.a, 'market');
    move(t.b, 'market');
    server!.db.prepare('update character set hp = 0 where member_id = ?').run(t.b.memberId);
    const before = dbDump();

    const knockedOut = applyPhaseActions(server!.orm, t.gameId, [hit(t.a, t.b)], new SeededRng(1), CLOCK);
    expect(knockedOut.ok).toBe(false);
    if (!knockedOut.ok) expect(knockedOut.errors.map((e) => e.code)).toEqual(['target_unconscious']);

    const ghost = applyPhaseActions(server!.orm, t.gameId, [{ ...hit(t.a, t.b), targetPlayer: targeting('no-such-member', { intent: 'harm' }) }], new SeededRng(1), CLOCK);
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.errors.map((e) => e.code)).toEqual(['unknown_target']);

    expect(dbDump()).toBe(before);
  });

  it('Q-080 / Q-104: a player sees timeline events they were at when they began (or town-wide); the Human GM sees all', async () => {
    const t = await table(true);
    move(t.a, 'fountain');
    move(t.b, 'forest');
    move(t.c, 'temple');
    advanceTimeline(server!.orm, t.gameId, { day: 7, phase: 'HESPERION' }, CLOCK);
    const timeline = async (who: { token: string }) => GameTimelineResponse.parse((await t.call('GET', '/api/game/timeline', { token: who.token })).body);

    // d1-bread (fountain) began at the start, before A got there; d7-kidnapping (temple) began with C there;
    // d5-disaster has no place (town-wide).
    expect((await timeline(t.a)).events.map((e) => e.id)).toEqual(['d5-disaster']);
    expect((await timeline(t.b)).events.map((e) => e.id)).toEqual(['d5-disaster']);
    move(t.c, 'forest');
    move(t.a, 'temple');
    expect((await timeline(t.c)).events.map((e) => e.id)).toEqual(['d5-disaster', 'd7-kidnapping']);
    expect((await timeline(t.a)).events.map((e) => e.id)).toEqual(['d5-disaster']);
    expect((await timeline(t.gm!)).events.map((e) => e.id)).toContain('d7-kidnapping');
    expect((await timeline(t.gm!)).events.map((e) => e.id)).toContain('d1-bread');
  });
});
