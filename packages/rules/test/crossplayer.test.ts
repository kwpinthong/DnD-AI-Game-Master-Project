import { describe, expect, it } from 'vitest';
import {
  ReplayRng,
  SeededRng,
  orderPhaseActions,
  replayPhaseActions,
  resolvePhaseActions,
  type ActionOutcome,
  type CrossPlayerState,
  type PhaseAction,
  type PhaseActionsResult,
  type PlayerEffects,
  type PlayerState,
  type PlayerTargeting,
  type ResolutionProposal,
} from '../src/index.ts';
import { CountingRng, noEffects, proposal } from './resolution-fixtures.ts';

/** GEN-060 cross-player rules (Rules Spec §10). Dice are fixed with ReplayRng: priority d20s in seat order, then each action's dice. */

function player(id: string, seat: number, patch: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    seat,
    locationId: 'market',
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
    remoteReach: [],
    ...patch,
  };
}

function state(...players: PlayerState[]): CrossPlayerState {
  return { players: Object.fromEntries(players.map((p) => [p.id, p])), npcs: {} };
}

const none: PlayerEffects = { damage: null, heal: null, takeItem: null, giveItem: null };

function targeting(patch: Partial<PlayerTargeting> & Pick<PlayerTargeting, 'player' | 'intent'>): PlayerTargeting {
  return { reachRef: null, defenseRef: null, perceptionRef: null, onSuccess: none, onFail: none, ...patch };
}

function action(actorId: string, patch: Partial<Omit<PhaseAction, 'proposal'>> & { proposal?: Partial<ResolutionProposal> } = {}): PhaseAction {
  const { proposal: p, ...rest } = patch;
  return {
    actorId,
    proposal: proposal({ actionId: `act-${actorId}`, check: { type: 'none' }, modifiers: [], ...p }),
    targetPlayer: null,
    moveTo: null,
    awareness: 'normal',
    ...rest,
  };
}

/** A steals B's purse: complex + opposed (6), pvp check, stat modifier. */
function steal(visibility: 'public' | 'secret'): PhaseAction {
  return action('pc-a', {
    proposal: {
      kind: 'complex',
      opposed: true,
      staminaCost: 6,
      tags: ['stealth'],
      visibility,
      check: { type: 'pvp' },
      modifiers: [{ source: 'stat' }],
      repDeltaIfCaught: -10,
      onSuccess: noEffects({ repDelta: -5, karmaDelta: -3 }),
      onFail: noEffects({ karmaDelta: -2 }),
    },
    targetPlayer: targeting({ player: 'pc-b', intent: 'steal', onSuccess: { ...none, takeItem: 'item-purse' } }),
  });
}

/** A hits B with a club: exertion 8, item +2, light damage (E7). */
function hit(patch: Partial<PlayerTargeting> = {}): PhaseAction {
  return action('pc-a', {
    proposal: {
      kind: 'exertion',
      staminaCost: 8,
      tags: ['physical'],
      check: { type: 'pvp' },
      modifiers: [{ source: 'stat' }, { source: 'item', ref: 'item-club', value: 2 }],
    },
    targetPlayer: targeting({ player: 'pc-b', intent: 'harm', onSuccess: { ...none, damage: 'light' }, ...patch }),
  });
}

/** B bargains at the market: general, no roll, no target. */
const bargain = () => action('pc-b');
const moveTo = (actorId: string, locationId: string) => action(actorId, { moveTo: locationId });

function expectOk(result: PhaseActionsResult) {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result;
}

function outcomeOf(result: { log: { outcomes: readonly ActionOutcome[] } }, actorId: string) {
  const outcome = result.log.outcomes.find((o) => o.actorId === actorId);
  if (!outcome) throw new Error(`no outcome for ${actorId}`);
  return outcome;
}

function resolved(outcome: ActionOutcome) {
  if (outcome.status !== 'resolved') throw new Error(`expected resolved, got ${outcome.status}`);
  return outcome;
}

const thiefAndMark = () =>
  state(
    player('pc-a', 0, { stamina: 18, skills: [{ id: 'skill-quickhands', tier: 'Common' }] }),
    player('pc-b', 1, { stamina: 12, hp: 80, items: [{ id: 'item-purse', tier: 'Common' }] }),
  );

describe('C1 A steals from B in public at the market', () => {
  // priority A 15 + 3 = 18, B 5 + 2 = 7 -> A first. DC_pvp 11 + 0; A d20 14 -> 14 >= 11 success.
  const result = expectOk(resolvePhaseActions({ state: thiefAndMark(), actions: [steal('public'), bargain()] }, new ReplayRng([15, 5, 14])));

  it('moves the item from B to A', () => {
    expect(result.state.players['pc-a']!.items.map((i) => i.id)).toContain('item-purse');
    expect(result.state.players['pc-b']!.items.map((i) => i.id)).not.toContain('item-purse');
  });

  it('tells B what was lost and that B knows who did it (Public)', () => {
    const steal = resolved(outcomeOf(result, 'pc-a'));
    expect(steal.log.check).toMatchObject({ dc: 11, d20: 14, total: 14 });
    expect(steal.log.degree).toBe('success');
    expect(steal.target).toMatchObject({ playerId: 'pc-b', itemsLost: ['item-purse'], itemsGained: [], knowsActor: true, observation: null });
  });

  it('applies the Public Reputation change and the PvP stamina cost', () => {
    expect(result.state.players['pc-a']).toMatchObject({ rep: -5, karma: -3, stamina: 12 });
  });
});

describe('C2 the target must be at the same place unless a capability allows it', () => {
  const apart = () =>
    state(
      player('pc-a', 0, { stamina: 20, items: [{ id: 'item-club', tier: 'Common' }, { id: 'item-doll', tier: 'Common' }], remoteReach: ['item-doll'] }),
      player('pc-b', 1, { stamina: 15, hp: 70, locationId: 'forest' }),
    );

  it('refuses at resolve: no_target, no roll, A pays general 3, B untouched', () => {
    const rng = new CountingRng(new ReplayRng([11, 9]));
    const result = expectOk(resolvePhaseActions({ state: apart(), actions: [hit()] }, rng));
    expect(outcomeOf(result, 'pc-a')).toMatchObject({ status: 'no_target', reason: 'not_same_place', targetId: 'pc-b' });
    expect(rng.calls).toBe(1); // only A's priority die
    expect(result.state.players['pc-a']!.stamina).toBe(17);
    expect(result.state.players['pc-b']).toEqual(apart().players['pc-b']);
  });

  it('allows it with an owned reach: remote item', () => {
    // A d20 14 + 2 = 16 vs DC 11, margin 5 -> 8 + 2 = 10 damage.
    const result = expectOk(resolvePhaseActions({ state: apart(), actions: [hit({ reachRef: 'item-doll' })] }, new ReplayRng([11, 14])));
    const outcome = resolved(outcomeOf(result, 'pc-a'));
    expect(outcome.target!.hp).toEqual({ before: 70, damage: 10, heal: 0, after: 60 });
    expect(result.state.players['pc-b']!.hp).toBe(60);
  });

  it('rejects a reach ref that is not a remote-reach capability', () => {
    const result = resolvePhaseActions({ state: apart(), actions: [hit({ reachRef: 'item-club' })] }, new ReplayRng([11, 14]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain('reach_not_remote');
  });
});

describe('C3 Secret steal that B does not notice', () => {
  // A total 14; B observes d20 10 + 0 = 10 <= 14.
  const result = expectOk(resolvePhaseActions({ state: thiefAndMark(), actions: [steal('secret'), bargain()] }, new ReplayRng([15, 5, 14, 10])));

  it('B loses the item but does not know who took it', () => {
    const outcome = resolved(outcomeOf(result, 'pc-a'));
    expect(outcome.target).toMatchObject({ itemsLost: ['item-purse'], knowsActor: false, observation: { d20: 10, modifier: 0, total: 10 } });
    expect(result.state.players['pc-a']!.items.map((i) => i.id)).toContain('item-purse');
  });

  it("A's Reputation does not change", () => {
    expect(resolved(outcomeOf(result, 'pc-a')).log.caught).toBe(false);
    expect(result.state.players['pc-a']!.rep).toBe(0);
  });

  it('a tie is unseen', () => {
    const tie = expectOk(resolvePhaseActions({ state: thiefAndMark(), actions: [steal('secret'), bargain()] }, new ReplayRng([15, 5, 14, 14])));
    const outcome = resolved(outcomeOf(tie, 'pc-a'));
    expect(outcome.target!.knowsActor).toBe(false);
    expect(outcome.log.caught).toBe(false);
    expect(outcome.target!.itemsLost).toEqual(['item-purse']);
  });
});

describe('C4 Secret steal that B notices', () => {
  // A total 14; B observes d20 16 > 14.
  const result = expectOk(resolvePhaseActions({ state: thiefAndMark(), actions: [steal('secret'), bargain()] }, new ReplayRng([15, 5, 14, 16])));

  it('B sees who did it and A counts as caught: Reputation changes by repDeltaIfCaught (GEN-051)', () => {
    const outcome = resolved(outcomeOf(result, 'pc-a'));
    expect(outcome.target!.knowsActor).toBe(true);
    expect(outcome.log.caught).toBe(true);
    expect(outcome.log.rep).toEqual({ before: 0, delta: -10, after: -10 });
    expect(result.state.players['pc-a']!.rep).toBe(-10);
  });

  it('the target noticing interrupts the steal: the item stays with B (spec §10.4)', () => {
    const outcome = resolved(outcomeOf(result, 'pc-a'));
    expect(outcome.log.interrupted).toBe(true);
    expect(outcome.log.degree).toBe('fail');
    expect(outcome.target!.itemsLost).toEqual([]);
    expect(result.state.players['pc-b']!.items.map((i) => i.id)).toEqual(['item-purse']);
  });

  it('watching raises B awareness by +3; a sleeping B gets -5', () => {
    const watch = { ...bargain(), awareness: 'watch' as const };
    // d20 12 + 3 = 15 > 14 -> noticed
    const watched = expectOk(resolvePhaseActions({ state: thiefAndMark(), actions: [steal('secret'), watch] }, new ReplayRng([15, 5, 14, 12])));
    expect(resolved(outcomeOf(watched, 'pc-a')).target!.observation).toEqual({ d20: 12, modifier: 3, total: 15, noticed: true });
    const asleep = { ...bargain(), awareness: 'asleep' as const };
    const slept = expectOk(resolvePhaseActions({ state: thiefAndMark(), actions: [steal('secret'), asleep] }, new ReplayRng([15, 5, 14, 18])));
    expect(resolved(outcomeOf(slept, 'pc-a')).target!.observation).toEqual({ d20: 18, modifier: -5, total: 13, noticed: false });
  });
});

describe('C5 A hits B while B leaves the market in the same phase (E7)', () => {
  const brawl = () =>
    state(player('pc-a', 0, { stamina: 20, items: [{ id: 'item-club', tier: 'Common' }] }), player('pc-b', 1, { stamina: 15, hp: 70 }));

  it('B first: B moves away, A finds no target and pays 3', () => {
    // A 6 + 4 = 10, B 9 + 3 = 12 -> B first.
    const result = expectOk(resolvePhaseActions({ state: brawl(), actions: [hit(), moveTo('pc-b', 'temple')] }, new ReplayRng([6, 9])));
    expect(result.log.order.order).toEqual(['pc-b', 'pc-a']);
    expect(resolved(outcomeOf(result, 'pc-b')).moved).toEqual({ from: 'market', to: 'temple' });
    expect(outcomeOf(result, 'pc-a')).toMatchObject({ status: 'no_target', reason: 'not_same_place' });
    expect(result.state.players['pc-b']).toMatchObject({ hp: 70, locationId: 'temple' });
    expect(result.state.players['pc-a']!.stamina).toBe(17);
  });

  it('A first: B is hit (70 -> 60), then still moves', () => {
    // A 11 + 4 = 15 > 12 -> A first; A d20 14 + 2 = 16 vs 11, margin 5 -> 10 damage.
    const result = expectOk(resolvePhaseActions({ state: brawl(), actions: [hit(), moveTo('pc-b', 'temple')] }, new ReplayRng([11, 9, 14])));
    expect(result.log.order.order).toEqual(['pc-a', 'pc-b']);
    expect(resolved(outcomeOf(result, 'pc-a')).target!.hp).toEqual({ before: 70, damage: 10, heal: 0, after: 60 });
    expect(result.state.players['pc-b']).toMatchObject({ hp: 60, locationId: 'temple' });
    expect(result.state.players['pc-a']!.stamina).toBe(12);
  });

  it('a player knocked out earlier in the phase does not act', () => {
    const weak = state(player('pc-a', 0, { stamina: 20, items: [{ id: 'item-club', tier: 'Common' }] }), player('pc-b', 1, { stamina: 15, hp: 5 }));
    const result = expectOk(resolvePhaseActions({ state: weak, actions: [hit(), moveTo('pc-b', 'temple')] }, new ReplayRng([11, 9, 14])));
    expect(outcomeOf(result, 'pc-b')).toEqual({ status: 'skipped', actionId: 'act-pc-b', actorId: 'pc-b', reason: 'actor_unconscious' });
    expect(result.state.players['pc-b']).toMatchObject({ hp: 0, locationId: 'market' });
  });
});

describe('C6 the order is seeded, logged and replayable; ties follow GEN-042 §10.5', () => {
  const three = () =>
    state(player('pc-a', 0, { stamina: 20 }), player('pc-b', 1, { stamina: 15, hp: 30 }), player('pc-c', 2, { stamina: 25, locationId: 'forest' }));
  const actions = () => [action('pc-a'), action('pc-b'), action('pc-c')];

  it('same stats and seed -> same order, every die in the log', () => {
    const first = expectOk(resolvePhaseActions({ state: three(), actions: actions() }, new SeededRng(7)));
    const second = expectOk(resolvePhaseActions({ state: three(), actions: actions() }, new SeededRng(7)));
    expect(second.log.order).toEqual(first.log.order);
    expect(first.log.order.priorities.map((p) => p.playerId)).toEqual(['pc-a', 'pc-b', 'pc-c']);
    expect(first.log.rolls.slice(0, 3)).toEqual(first.log.order.priorities.map((p) => p.d20));
    expect(replayPhaseActions(first.log)).toEqual(first);
  });

  it('priority = d20 + floor(Stamina / 5) + stat(priority): บาดเจ็บ -1', () => {
    const log = orderPhaseActions(Object.values(three().players), new ReplayRng([10, 10, 10]));
    expect(log.priorities).toEqual([
      { playerId: 'pc-a', d20: 10, staminaBonus: 4, stat: 0, priority: 14 },
      { playerId: 'pc-b', d20: 10, staminaBonus: 3, stat: -1, priority: 12 },
      { playerId: 'pc-c', d20: 10, staminaBonus: 5, stat: 0, priority: 15 },
    ]);
    expect(log.order).toEqual(['pc-c', 'pc-a', 'pc-b']);
  });

  it('tie -> higher Stamina first (E7: A 8 + 4 = B 9 + 3)', () => {
    const log = orderPhaseActions([player('pc-a', 0, { stamina: 20 }), player('pc-b', 1, { stamina: 15 })], new ReplayRng([8, 9]));
    expect(log.order).toEqual(['pc-a', 'pc-b']);
    expect(log.rollOffs).toEqual([]);
  });

  it('tie with same Stamina -> higher HP first', () => {
    const log = orderPhaseActions([player('pc-a', 0, { hp: 60 }), player('pc-b', 1, { hp: 90 })], new ReplayRng([10, 10]));
    expect(log.order).toEqual(['pc-b', 'pc-a']);
  });

  it('tie with same Stamina and HP -> roll-off d20, higher first', () => {
    const log = orderPhaseActions([player('pc-a', 0), player('pc-b', 1)], new ReplayRng([10, 10, 5, 12]));
    expect(log.order).toEqual(['pc-b', 'pc-a']);
    expect(log.rollOffs).toEqual([{ round: 1, rolls: [{ playerId: 'pc-a', d20: 5 }, { playerId: 'pc-b', d20: 12 }] }]);
  });

  it('roll-off tied 3 rounds -> seat order', () => {
    const log = orderPhaseActions([player('pc-b', 1), player('pc-a', 0)], new ReplayRng([10, 10, 4, 4, 9, 9, 2, 2]));
    expect(log.rollOffs).toHaveLength(3);
    expect(log.order).toEqual(['pc-a', 'pc-b']);
  });
});

describe('C8 targeting an unconscious player or an unknown id is refused and nothing changes', () => {
  it('unknown id', () => {
    const rng = new CountingRng(new SeededRng(1));
    const input = { state: thiefAndMark(), actions: [{ ...steal('public'), targetPlayer: targeting({ player: 'pc-ghost', intent: 'harm' }) }] };
    const result = resolvePhaseActions(input, rng);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.objectContaining({ code: 'unknown_target', action: 0, path: 'targetPlayer.player' })]);
    expect(rng.calls).toBe(0);
    expect(input.state).toEqual(thiefAndMark());
  });

  it('unconscious (HP 0) target of a harmful action; one bad action rejects the whole phase', () => {
    const rng = new CountingRng(new SeededRng(1));
    const knockedOut = state(player('pc-a', 0, { items: [{ id: 'item-club', tier: 'Common' }] }), player('pc-b', 1, { hp: 0 }), player('pc-c', 2));
    const result = resolvePhaseActions({ state: knockedOut, actions: [action('pc-c'), hit()] }, rng);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => [e.code, e.action])).toEqual([['target_unconscious', 1]]);
    expect(rng.calls).toBe(0);
  });

  it('stealing from an unconscious player is allowed, with no observation roll', () => {
    const knockedOut = state(player('pc-a', 0, { stamina: 18 }), player('pc-b', 1, { hp: 0, items: [{ id: 'item-purse', tier: 'Common' }] }));
    const result = expectOk(resolvePhaseActions({ state: knockedOut, actions: [steal('secret')] }, new ReplayRng([15, 14])));
    expect(resolved(outcomeOf(result, 'pc-a')).target).toMatchObject({ itemsLost: ['item-purse'], observation: null, knowsActor: false });
  });

  it('a target cannot be the actor itself, and a pvp check needs a player target', () => {
    const self = { ...steal('public'), targetPlayer: targeting({ player: 'pc-a', intent: 'harm' }) };
    const noTarget = { ...steal('public'), targetPlayer: null };
    const result = resolvePhaseActions({ state: thiefAndMark(), actions: [self, { ...noTarget, actorId: 'pc-b' }] }, new SeededRng(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['target_is_actor', 'pvp_without_target']));
  });

  it('the stolen item must be owned by the target', () => {
    const bad = { ...steal('public'), targetPlayer: targeting({ player: 'pc-b', intent: 'steal', onSuccess: { ...none, takeItem: 'item-crown' } }) };
    const result = resolvePhaseActions({ state: thiefAndMark(), actions: [bad] }, new SeededRng(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain('ref_not_owned');
  });
});
