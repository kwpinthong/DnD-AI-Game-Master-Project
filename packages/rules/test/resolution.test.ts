import { describe, expect, it } from 'vitest';
import {
  ReplayRng,
  SeededRng,
  replayResolution,
  resolveAction,
  type ResolutionState,
  type ResolveResult,
} from '../src/index.ts';
import { CountingRng, baseState, noEffects, proposal } from './resolution-fixtures.ts';

function expectOk(result: ResolveResult) {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result;
}

function errorCodes(result: ResolveResult) {
  if (result.ok) throw new Error('expected the proposal to be rejected');
  return result.errors.map((e) => e.code);
}

function withActor(patch: Partial<ResolutionState['actor']>): ResolutionState {
  const state = baseState();
  return { ...state, actor: { ...state.actor, ...patch } };
}

describe('C1 valid proposal with a known seed', () => {
  // E1: persuade the guard. complex + opposed (6), DC 14, rep +18 favor, affinity guard +25, Common letter +2.
  const state = withActor({ stamina: 22, rep: 18, affinity: { 'npc-guard': 25 } });
  const input = {
    state,
    proposal: proposal({
      kind: 'complex',
      opposed: true,
      staminaCost: 6,
      tags: ['social'],
      check: { type: 'dc', dc: 14 },
      target: { npc: 'npc-guard' },
      modifiers: [
        { source: 'stat' },
        { source: 'rep', mode: 'favor' },
        { source: 'affinity', ref: 'npc-guard' },
        { source: 'item', ref: 'item-letter', value: 2 },
      ],
      onSuccess: noEffects({ repDelta: 2, affinity: [{ npcId: 'npc-guard', delta: 3 }] }),
    }),
  };

  it('matches the GEN-042 formula: d20 13 + clamp(0 + 1 + 1 + 2) = 17 >= 14 -> success', () => {
    // SeededRng(42) yields 13 on the first d20 (see dice.test.ts).
    const result = expectOk(resolveAction(input, new SeededRng(42)));
    const { log } = result;

    expect(log.check).toEqual({
      dc: 14,
      d20: 13,
      modifiers: [
        { source: 'stat', value: 0 },
        { source: 'rep', mode: 'favor', value: 1 },
        { source: 'affinity', ref: 'npc-guard', value: 1 },
        { source: 'item', ref: 'item-letter', value: 2 },
      ],
      modifierSum: 4,
      modifierTotal: 4,
      total: 17,
      margin: 3,
    });
    expect(log.degree).toBe('success');
    expect(result.state.actor.stamina).toBe(16);
    expect(result.state.actor.rep).toBe(20);
    expect(result.state.actor.affinity['npc-guard']).toBe(28);
  });

  it('logs every input: the state snapshot, the raw proposal and every die', () => {
    const { log } = expectOk(resolveAction(input, new SeededRng(42)));
    expect(log.input.state).toEqual(input.state);
    expect(log.input.proposal).toEqual(input.proposal);
    expect(log.rolls).toEqual([13]);
    expect(log.stamina).toEqual({ before: 22, cost: 6, net: 6, after: 16 });
    expect(log.rep).toEqual({ before: 18, delta: 2, after: 20 });
    expect(log.karma).toEqual({ before: 0, delta: 0, after: 0 });
    expect(log.affinity).toEqual([{ npcId: 'npc-guard', before: 25, delta: 3, after: 28 }]);
  });

  it('keeps the log independent of later changes to the caller objects', () => {
    const local = structuredClone(input);
    const { log } = expectOk(resolveAction(local, new SeededRng(42)));
    local.state.actor.stamina = 1;
    expect(log.input.state.actor.stamina).toBe(22);
  });

  it('clamps the modifier total at +/-10 and logs both sums', () => {
    const state = withActor({
      rep: 90,
      karma: 80,
      affinity: { 'npc-guard': 100 },
      items: [
        { id: 'item-a', tier: 'Legendary' },
        { id: 'item-b', tier: 'Legendary' },
      ],
    });
    const { log } = expectOk(
      resolveAction(
        {
          state,
          proposal: proposal({
            modifiers: [
              { source: 'item', ref: 'item-a', value: 5 },
              { source: 'item', ref: 'item-b', value: 5 },
              { source: 'rep', mode: 'favor' },
              { source: 'karma', align: 'light' },
              { source: 'affinity', ref: 'npc-guard' },
            ],
          }),
        },
        new ReplayRng([5]),
      ),
    );
    expect(log.check?.modifierSum).toBe(5 + 5 + 3 + 2 + 5);
    expect(log.check?.modifierTotal).toBe(10);
    expect(log.check?.total).toBe(15);
  });

  it('marks nat 20 as crit and nat 1 as fumble regardless of total (Q-053: no widened range)', () => {
    const crit = expectOk(resolveAction({ state: baseState(), proposal: proposal({ check: { type: 'dc', dc: 23 } }) }, new ReplayRng([20])));
    expect(crit.log.degree).toBe('crit');
    const fumble = expectOk(resolveAction({ state: baseState(), proposal: proposal({ check: { type: 'dc', dc: 5 } }) }, new ReplayRng([1])));
    expect(fumble.log.degree).toBe('fumble');
    const nineteen = expectOk(resolveAction({ state: baseState(), proposal: proposal({ check: { type: 'dc', dc: 23 } }) }, new ReplayRng([19])));
    expect(nineteen.log.degree).toBe('fail');
    const two = expectOk(resolveAction({ state: baseState(), proposal: proposal({ check: { type: 'dc', dc: 5 } }) }, new ReplayRng([2])));
    expect(two.log.degree).toBe('fail');
  });
});

describe('C2 out-of-bounds proposal is rejected as a whole and the state does not change', () => {
  const cases: [string, Parameters<typeof proposal>[0], string][] = [
    ['DC not on the ladder', { check: { type: 'dc', dc: 12 as 11 } }, 'dc_not_on_ladder'],
    ['Common item over its cap', { modifiers: [{ source: 'item', ref: 'item-letter', value: 3 }] }, 'value_over_cap'],
    ['modifier without a source', { modifiers: [{ ref: 'item-letter', value: 1 } as never] }, 'missing_source'],
    ['source outside the six', { modifiers: [{ source: 'luck', value: 2 } as never] }, 'unknown_source'],
    ['item the actor does not own', { modifiers: [{ source: 'item', ref: 'item-crown', value: 1 }] }, 'ref_not_owned'],
    ['item without a ref', { modifiers: [{ source: 'item', value: 1 } as never] }, 'missing_ref'],
    ['AI puts a number on a derived source', { modifiers: [{ source: 'stat', value: 4 } as never] }, 'derived_value_given'],
    ['three items', {
      modifiers: [
        { source: 'item', ref: 'item-letter', value: 1 },
        { source: 'item', ref: 'item-dagger', value: 1 },
        { source: 'item', ref: 'item-hairpin', value: 1 },
      ],
    }, 'too_many'],
    ['stamina cost not matching the kind', { kind: 'complex', staminaCost: 3 }, 'stamina_cost_mismatch'],
    ['affinity delta over +/-10', { onSuccess: noEffects({ affinity: [{ npcId: 'npc-guard', delta: 11 }] }) }, 'out_of_range'],
    ['rep delta over +/-10', { onFail: noEffects({ repDelta: -12 }) }, 'out_of_range'],
    ['affinity for an NPC who is not here', { onSuccess: noEffects({ affinity: [{ npcId: 'npc-far', delta: 2 }] }) }, 'npc_not_present'],
    ['event status over +/-3', {
      onSuccess: noEffects({ addStatus: [{ label: 'พร', polarity: 'buff', mods: [{ scope: 'faith', value: 4 }], phases: 3, visible: false }] }),
    }, 'out_of_range'],
    ['event status that widens the crit range (Q-053)', {
      onSuccess: noEffects({ addStatus: [{ label: 'โชค', polarity: 'buff', mods: [{ scope: 'critRange' as 'all', value: 1 }], phases: 2, visible: false }] }),
    }, 'unknown_scope'],
  ];

  it.each(cases)('%s', (_name, patch, code) => {
    const state = baseState();
    const before = structuredClone(state);
    const rng = new CountingRng(new SeededRng(1));
    const result = resolveAction({ state, proposal: proposal(patch) }, rng);

    expect(errorCodes(result)).toContain(code);
    expect(state).toEqual(before);
    expect(rng.calls).toBe(0);
  });

  it('rejects the whole proposal when only onFail is wrong, and reports every error at once', () => {
    const state = baseState();
    const before = structuredClone(state);
    const result = resolveAction(
      {
        state,
        proposal: proposal({
          check: { type: 'dc', dc: 13 as 11 },
          modifiers: [{ source: 'item', ref: 'item-letter', value: 1 }],
          onFail: noEffects({ karmaDelta: 50 }),
        }),
      },
      new SeededRng(1),
    );
    expect(errorCodes(result)).toEqual(['dc_not_on_ladder', 'out_of_range']);
    expect(state).toEqual(before);
  });

  it('accepts Legendary +5 and a burden item at -2', () => {
    const state = withActor({ items: [{ id: 'item-sword', tier: 'Legendary' }, { id: 'item-anvil', tier: 'Common' }] });
    const result = resolveAction(
      {
        state,
        proposal: proposal({
          modifiers: [
            { source: 'item', ref: 'item-sword', value: 5 },
            { source: 'item', ref: 'item-anvil', value: -2 },
          ],
        }),
      },
      new ReplayRng([10]),
    );
    expect(expectOk(result).log.check?.modifierSum).toBe(3);
  });

  it('rejects any proposal from an unconscious actor', () => {
    const result = resolveAction({ state: withActor({ hp: 0 }), proposal: proposal() }, new SeededRng(1));
    expect(errorCodes(result)).toContain('actor_unconscious');
  });
});

describe('C3 reputation follows visibility, karma always changes', () => {
  const effects = noEffects({ repDelta: 4, karmaDelta: -3 });

  it('Public success changes Reputation and Karma', () => {
    const result = expectOk(
      resolveAction({ state: baseState(), proposal: proposal({ visibility: 'public', onSuccess: effects }) }, new ReplayRng([15])),
    );
    expect(result.log.degree).toBe('success');
    expect(result.state.actor.rep).toBe(4);
    expect(result.state.actor.karma).toBe(-3);
  });

  it('Secret success unseen keeps Reputation but changes Karma', () => {
    const result = expectOk(
      resolveAction(
        { state: baseState(), proposal: proposal({ visibility: 'secret', repDeltaIfCaught: -8, onSuccess: effects }) },
        new ReplayRng([15]),
      ),
    );
    expect(result.log.caught).toBe(false);
    expect(result.state.actor.rep).toBe(0);
    expect(result.state.actor.karma).toBe(-3);
  });

  it('Secret caught by an NPC witness applies repDeltaIfCaught (E3)', () => {
    // d20 7 + 2 = 9 vs DC 14 -> fail; priest (grade A +3) d20 8 -> 11 > 9 -> caught.
    const state = withActor({ stamina: 20, rep: 5, karma: 25 });
    const result = expectOk(
      resolveAction(
        {
          state,
          proposal: proposal({
            kind: 'complex',
            staminaCost: 5,
            visibility: 'secret',
            check: { type: 'dc', dc: 14 },
            modifiers: [{ source: 'stat' }, { source: 'item', ref: 'item-hairpin', value: 1 }, { source: 'karma', align: 'light' }],
            witnessNpcIds: ['npc-guard', 'npc-priest'],
            repDeltaIfCaught: -8,
          }),
        },
        new ReplayRng([7, 8]),
      ),
    );
    expect(result.log.degree).toBe('fail');
    expect(result.log.observation).toEqual({ npcId: 'npc-priest', d20: 8, total: 11 });
    expect(result.log.caught).toBe(true);
    expect(result.state.actor.rep).toBe(-3);
    expect(result.state.actor.stamina).toBe(15);
  });

  it('a witness tie is not caught', () => {
    const result = expectOk(
      resolveAction(
        { state: baseState(), proposal: proposal({ visibility: 'secret', witnessNpcIds: ['npc-guard'], repDeltaIfCaught: -5 }) },
        new ReplayRng([10, 9]), // actor total 10, guard 9 + 1 = 10
      ),
    );
    expect(result.log.caught).toBe(false);
    expect(result.state.actor.rep).toBe(0);
  });

  it('a Secret fumble is caught at once without a witness roll', () => {
    const result = expectOk(
      resolveAction(
        { state: baseState(), proposal: proposal({ visibility: 'secret', witnessNpcIds: ['npc-guard'], repDeltaIfCaught: -6 }) },
        new ReplayRng([1]),
      ),
    );
    expect(result.log.rolls).toEqual([1]);
    expect(result.log.caught).toBe(true);
    expect(result.state.actor.rep).toBe(-6);
  });
});

describe('C4 stamina by class', () => {
  const run = (patch: Parameters<typeof proposal>[0], stamina = 30, d20 = 10, afterActionStamina = 0) =>
    expectOk(resolveAction({ state: withActor({ stamina, afterActionStamina }), proposal: proposal(patch) }, new ReplayRng([d20]))).state.actor
      .stamina;

  it('general -3, complex -5, complex opposed -6, exertion up to -10', () => {
    expect(run({ kind: 'general', staminaCost: 3 })).toBe(27);
    expect(run({ kind: 'complex', staminaCost: 5 })).toBe(25);
    expect(run({ kind: 'complex', opposed: true, staminaCost: 6 })).toBe(24);
    expect(run({ kind: 'exertion', staminaCost: 10 })).toBe(20);
    expect(run({ kind: 'exertion', staminaCost: 7 })).toBe(23);
  });

  it('Stamina 2 paying 3 ends at 0, never negative', () => {
    expect(run({ kind: 'general', staminaCost: 3 }, 2)).toBe(0);
  });

  it('crit pays half (rounded up), fumble pays +2', () => {
    expect(run({ kind: 'exertion', staminaCost: 9 }, 30, 20)).toBe(25);
    expect(run({ kind: 'complex', staminaCost: 5 }, 30, 1)).toBe(23);
  });

  it('an after-action refund never makes the net cost below 1 (M1, Q-037)', () => {
    expect(run({ kind: 'general', staminaCost: 3 }, 20, 10, 3)).toBe(19);
    expect(run({ kind: 'complex', staminaCost: 5 }, 20, 10, 3)).toBe(18);
  });

  it('rejects exertion outside 7..10 and opposed general', () => {
    expect(errorCodes(resolveAction({ state: baseState(), proposal: proposal({ kind: 'exertion', staminaCost: 11 }) }, new SeededRng(1)))).toContain(
      'stamina_cost_mismatch',
    );
    expect(errorCodes(resolveAction({ state: baseState(), proposal: proposal({ kind: 'complex', opposed: true, staminaCost: 5 }) }, new SeededRng(1)))).toContain(
      'stamina_cost_mismatch',
    );
  });
});

describe('C5 affinity and reputation clamp at -100..+100', () => {
  it('affinity 95 + 10 -> 100', () => {
    const result = expectOk(
      resolveAction(
        {
          state: withActor({ affinity: { 'npc-guard': 95 } }),
          proposal: proposal({ onSuccess: noEffects({ affinity: [{ npcId: 'npc-guard', delta: 10 }] }) }),
        },
        new ReplayRng([15]),
      ),
    );
    expect(result.state.actor.affinity['npc-guard']).toBe(100);
    expect(result.log.affinity).toEqual([{ npcId: 'npc-guard', before: 95, delta: 10, after: 100 }]);
  });

  it('reputation -98 - 5 -> -100', () => {
    const result = expectOk(
      resolveAction({ state: withActor({ rep: -98 }), proposal: proposal({ onFail: noEffects({ repDelta: -5 }) }) }, new ReplayRng([3])),
    );
    expect(result.state.actor.rep).toBe(-100);
  });

  it('crit adds +2 to a positive affinity delta but never past +10 per action; fumble adds -2 down to -10', () => {
    const crit = expectOk(
      resolveAction(
        { state: baseState(), proposal: proposal({ onSuccess: noEffects({ affinity: [{ npcId: 'npc-guard', delta: 9 }] }) }) },
        new ReplayRng([20]),
      ),
    );
    expect(crit.state.actor.affinity['npc-guard']).toBe(10);
    const fumble = expectOk(
      resolveAction(
        { state: baseState(), proposal: proposal({ onFail: noEffects({ affinity: [{ npcId: 'npc-priest', delta: -9 }] }) }) },
        new ReplayRng([1]),
      ),
    );
    expect(fumble.state.actor.affinity['npc-priest']).toBe(-10);
  });

  it('karma clamps at -100..+100 too', () => {
    const result = expectOk(
      resolveAction({ state: withActor({ karma: 95 }), proposal: proposal({ onSuccess: noEffects({ karmaDelta: 10 }) }) }, new ReplayRng([15])),
    );
    expect(result.state.actor.karma).toBe(100);
  });
});

describe('C6 HP 0 means unconscious, never dead (Q-036, Q-057)', () => {
  it('HP 12 taking moderate self-damage ends at 0 and the actor is unconscious', () => {
    const result = expectOk(
      resolveAction(
        { state: withActor({ hp: 12 }), proposal: proposal({ onFail: noEffects({ selfDamage: 'moderate' }) }) },
        new ReplayRng([3]),
      ),
    );
    expect(result.state.actor.hp).toBe(0);
    expect(result.log.actorCondition).toBe('unconscious');
    expect(result.log.hp.actor).toEqual({ before: 12, damage: 15, heal: 0, after: 0 });
  });

  it('a fumble multiplies self-damage by 1.5 (rounded down)', () => {
    const result = expectOk(
      resolveAction({ state: baseState(), proposal: proposal({ onFail: noEffects({ selfDamage: 'moderate' }) }) }, new ReplayRng([1])),
    );
    expect(result.state.actor.hp).toBe(100 - 22);
    expect(result.log.actorCondition).toBe('ok');
  });

  it('an NPC at HP 0 takes no further damage', () => {
    const state = baseState();
    const npcs = { ...state.npcs, 'npc-guard': { ...state.npcs['npc-guard']!, hp: 0 } };
    const result = expectOk(
      resolveAction(
        { state: { ...state, npcs }, proposal: proposal({ target: { npc: 'npc-guard' }, onSuccess: noEffects({ damage: 'heavy' }) }) },
        new ReplayRng([15]),
      ),
    );
    expect(result.state.npcs['npc-guard']?.hp).toBe(0);
    expect(result.log.hp.target).toEqual({ npcId: 'npc-guard', before: 0, damage: 0, heal: 0, after: 0 });
  });
});

describe('C7 replaying a log gives the same result in every value', () => {
  const input = {
    state: withActor({ stamina: 12, hp: 40, rep: -20, karma: -30, affinity: { 'npc-guard': 30, 'npc-priest': -15 } }),
    proposal: proposal({
      kind: 'exertion',
      staminaCost: 8,
      tags: ['physical'],
      visibility: 'secret',
      target: { npc: 'npc-guard' },
      check: { type: 'dc', dc: 14 },
      modifiers: [{ source: 'stat' }, { source: 'item', ref: 'item-dagger', value: 3 }, { source: 'karma', align: 'dark' }, { source: 'affinity', ref: 'npc-guard' }],
      witnessNpcIds: ['npc-priest'],
      repDeltaIfCaught: -7,
      onSuccess: noEffects({
        karmaDelta: -4,
        damage: 'moderate',
        affinity: [{ npcId: 'npc-guard', delta: -6 }],
        addStatus: [{ label: 'ได้ใจ', polarity: 'buff', mods: [{ scope: 'stealth', value: 2 }], phases: 3, visible: false }],
      }),
      onFail: noEffects({ karmaDelta: -2, selfDamage: 'light' }),
    }),
  };

  it('replay(log) deep-equals the original result for many seeds', () => {
    for (let seed = 0; seed < 200; seed++) {
      const original = expectOk(resolveAction(input, new SeededRng(seed)));
      const replayed = replayResolution(JSON.parse(JSON.stringify(original.log)));
      expect(replayed).toEqual(original);
    }
  });

  it('a log whose rolls were tampered with does not replay to the same result', () => {
    const original = expectOk(resolveAction(input, new SeededRng(3)));
    const face = original.log.rolls[0]!;
    const tampered = { ...original.log, rolls: [face === 20 ? 19 : face + 1, ...original.log.rolls.slice(1)] };
    let replayed: ResolveResult | undefined;
    try {
      replayed = replayResolution(tampered);
    } catch {
      return; // fewer or more dice needed than recorded also counts as a mismatch
    }
    expect(replayed).not.toEqual(original);
  });

  it('ReplayRng refuses to invent a die that was not recorded', () => {
    const rng = new ReplayRng([4]);
    expect(rng.nextInt(1, 20)).toBe(4);
    expect(() => rng.nextInt(1, 20)).toThrow();
    expect(() => new ReplayRng([21]).nextInt(1, 20)).toThrow();
  });
});
