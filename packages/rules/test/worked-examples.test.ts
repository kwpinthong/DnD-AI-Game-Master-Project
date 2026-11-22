import { describe, expect, it } from 'vitest';
import {
  ReplayRng,
  SeededRng,
  computeStat,
  rescueScore,
  resolveAction,
  rollRescue,
  wakeAfter,
  type ResolutionState,
  type ResolveResult,
} from '../src/index.ts';
import { baseState, noEffects, proposal } from './resolution-fixtures.ts';

// Rules Spec §15 worked examples that a single action covers (E6, E7 need PvP / ordering: GEN-052).

function expectOk(result: ResolveResult) {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result;
}

function withActor(patch: Partial<ResolutionState['actor']>, npcs: ResolutionState['npcs'] = baseState().npcs): ResolutionState {
  const state = baseState();
  return { npcs, actor: { ...state.actor, ...patch } };
}

describe('Rules Spec §15 worked examples', () => {
  it('E2 fail: tired climber, exertion 8 vs DC 17', () => {
    const r = expectOk(
      resolveAction(
        {
          state: withActor({ stamina: 9, hp: 60 }),
          proposal: proposal({
            kind: 'exertion',
            staminaCost: 8,
            tags: ['physical'],
            check: { type: 'dc', dc: 17 },
            modifiers: [{ source: 'stat' }, { source: 'skill', ref: 'skill-climb', value: 2 }],
            onFail: noEffects({ selfDamage: 'light' }),
          }),
        },
        new ReplayRng([9]),
      ),
    );
    expect(r.log.check?.modifiers.map((m) => m.value)).toEqual([-2, 2]);
    expect(r.log.check?.total).toBe(9);
    expect(r.log.degree).toBe('fail');
    expect(r.state.actor.hp).toBe(52);
    expect(r.state.actor.stamina).toBe(1);
  });

  it('E4 overexert: Stamina 4, complex opposed 6 -> stat -4; d20 15 success, d20 2 only fail (Q-053)', () => {
    const state = withActor({ stamina: 4, affinity: { 'npc-guard': 10 } });
    const p = proposal({
      kind: 'complex',
      opposed: true,
      staminaCost: 6,
      tags: ['social'],
      target: { npc: 'npc-guard' },
      check: { type: 'dc', dc: 11 },
      modifiers: [{ source: 'stat' }, { source: 'rep', mode: 'favor' }, { source: 'affinity', ref: 'npc-guard' }],
    });
    const r = expectOk(resolveAction({ state, proposal: p }, new ReplayRng([15])));
    expect(r.log.check?.modifierTotal).toBe(-4);
    expect(r.log.check?.total).toBe(11);
    expect(r.log.degree).toBe('success');
    expect(r.state.actor.stamina).toBe(0);
    expect(expectOk(resolveAction({ state, proposal: p }, new ReplayRng([2]))).log.degree).toBe('fail');
  });

  it('E5 crit: nat 20, Rare dagger +3, karma light +1, moderate damage x1.5', () => {
    const npcs = {
      'npc-thug': { id: 'npc-thug', grade: 'B' as const, hp: 60, locationId: 'market', obsTrait: 0, damageReduction: 0 },
      'npc-orphan': { id: 'npc-orphan', grade: 'F' as const, hp: 40, locationId: 'market', obsTrait: 0, damageReduction: 0 },
    };
    const r = expectOk(
      resolveAction(
        {
          state: withActor({ karma: 25, affinity: {} }, npcs),
          proposal: proposal({
            kind: 'exertion',
            staminaCost: 8,
            tags: ['physical'],
            target: { npc: 'npc-thug' },
            check: { type: 'dc', dc: 14 },
            modifiers: [{ source: 'stat' }, { source: 'item', ref: 'item-dagger', value: 3 }, { source: 'karma', align: 'light' }],
            onSuccess: noEffects({ damage: 'moderate', karmaDelta: 3, affinity: [{ npcId: 'npc-orphan', delta: 5 }] }),
          }),
        },
        new ReplayRng([20]),
      ),
    );
    expect(r.log.degree).toBe('crit');
    expect(r.log.check?.total).toBe(24);
    expect(r.state.npcs['npc-thug']?.hp).toBe(30);
    expect(r.state.actor.stamina).toBe(26);
    expect(r.state.actor.affinity['npc-orphan']).toBe(7);
    expect(r.state.actor.karma).toBe(28);
  });

  it('E8 HP 0 -> unconscious, then the rescue roll bands', () => {
    const r = expectOk(
      resolveAction(
        {
          state: withActor({ hp: 12, stamina: 14 }),
          proposal: proposal({
            kind: 'complex',
            staminaCost: 5,
            check: { type: 'dc', dc: 14 },
            onFail: noEffects({ selfDamage: 'moderate' }),
          }),
        },
        new ReplayRng([6]),
      ),
    );
    expect(r.log.check?.modifierTotal).toBe(-2);
    expect(r.log.check?.total).toBe(4);
    expect(r.state.actor.hp).toBe(0);
    expect(r.log.actorCondition).toBe('unconscious');
    expect(r.state.actor.stamina).toBe(9);

    // a) nobody helps: d20 13, danger -4, companion +52 -> +4 -> 13 alone
    const alone = rollRescue({ safety: 'danger', primaryAffinity: 52 }, new ReplayRng([13]));
    expect(alone).toEqual({ d20: 13, score: 13, outcome: 'alone' });
    expect(wakeAfter('alone', 9)).toEqual({ hp: 10, stamina: 15 });
    // b) a player aided at DC 8 -> rescued without a roll
    expect(wakeAfter('rescued', 9)).toEqual({ hp: 30, stamina: 20 });
    // c) d20 3 -> exploited; d) same roll at the inn -> 11 alone
    expect(rollRescue({ safety: 'danger', primaryAffinity: 52 }, new ReplayRng([3])).outcome).toBe('exploited');
    expect(wakeAfter('exploited', 9)).toEqual({ hp: 10, stamina: 10 });
    expect(rescueScore(3, 'safe', 52)).toBe(11);
  });

  it('rescue bands are >= 15 rescued / 8..14 alone / <= 7 exploited, and wake keeps higher Stamina', () => {
    expect(rollRescue({ safety: 'normal', primaryAffinity: 0 }, new ReplayRng([15])).outcome).toBe('rescued');
    expect(rollRescue({ safety: 'normal', primaryAffinity: 0 }, new ReplayRng([14])).outcome).toBe('alone');
    expect(rollRescue({ safety: 'normal', primaryAffinity: 0 }, new ReplayRng([8])).outcome).toBe('alone');
    expect(rollRescue({ safety: 'normal', primaryAffinity: 0 }, new ReplayRng([7])).outcome).toBe('exploited');
    expect(rescueScore(10, 'normal', -45)).toBe(10 - 4);
    // Q-161: a RESTRICTED place counts as normal until it has a number.
    expect(rescueScore(10, 'restricted', 0)).toBe(rescueScore(10, 'normal', 0));
    expect(wakeAfter('alone', 22)).toEqual({ hp: 10, stamina: 22 });
    const seeded = rollRescue({ safety: 'safe', primaryAffinity: 20 }, new SeededRng(42));
    expect(seeded).toEqual({ d20: 13, score: 19, outcome: 'rescued' });
  });

  it('E9 actor side: hangover (all -1) gives stat -1 and no widened fumble (Q-053)', () => {
    const state = withActor({
      stamina: 20,
      karma: -30,
      statuses: [
        { id: 'st-hangover', label: 'เมาค้าง', polarity: 'debuff', origin: 'event', visible: false, mods: [{ scope: 'all', value: -1 }], phasesLeft: 2 },
      ],
    });
    expect(computeStat(state.actor, { kind: 'complex', tags: ['stealth'], staminaCost: 6 })).toBe(-1);
    const lin = withActor({
      stamina: 22,
      hp: 72,
      statuses: [{ id: 'tr-keen', label: 'ช่างสังเกต', polarity: 'buff', origin: 'trait', visible: false, mods: [{ scope: 'observe', value: 2 }], phasesLeft: null }],
    }).actor;
    expect(computeStat(lin, { use: 'observe' })).toBe(2);
    const r = expectOk(
      resolveAction(
        {
          state,
          proposal: proposal({
            kind: 'complex',
            opposed: true,
            staminaCost: 6,
            tags: ['stealth'],
            visibility: 'secret',
            check: { type: 'dc', dc: 14 },
            modifiers: [{ source: 'stat' }, { source: 'karma', align: 'dark' }],
          }),
        },
        new ReplayRng([2]),
      ),
    );
    expect(r.log.degree).toBe('fail');
    expect(r.log.caught).toBe(false);
  });

  it('condition table: tired / worn out / hurt / critical by kind, plus overexert -2 (Q-050)', () => {
    const actor = baseState().actor;
    expect(computeStat({ ...actor, stamina: 7 }, { kind: 'exertion', tags: [], staminaCost: 7 })).toBe(-2);
    expect(computeStat({ ...actor, stamina: 3 }, { kind: 'exertion', tags: [], staminaCost: 7 })).toBe(-6); // -4 - 2, clamp 6
    expect(computeStat({ ...actor, stamina: 3 }, { kind: 'general', tags: [], staminaCost: 3 })).toBe(-1); // no overexert on general
    expect(computeStat({ ...actor, hp: 30 }, { kind: 'complex', tags: [], staminaCost: 5 })).toBe(-1);
    expect(computeStat({ ...actor, hp: 10, stamina: 2 }, { kind: 'exertion', tags: [], staminaCost: 8 })).toBe(-6); // -3 -4 -2 = -9 -> -6
    expect(computeStat({ ...actor, hp: 10 }, { use: 'defense' })).toBe(-2);
  });
});
