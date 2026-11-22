import { describe, expect, it } from 'vitest';
import {
  ReplayRng,
  replayResolution,
  resolveAction,
  resolvePhaseActions,
  type CrossPlayerState,
  type PlayerState,
  type ResolutionState,
  type StatusEffect,
  type TagContext,
  type TagSource,
} from '../src/index.ts';
import { baseState, noEffects, proposal } from './resolution-fixtures.ts';

/**
 * GEN-095 (Q-142): a curse (Venom of Despair, "ทอยเต๋าทุกชนิด -3") is a status on its holder that moves every d20
 * the holder rolls: their own action (without a `stat` claim too), noticing a Secret, and for an NPC its witness
 * roll and its resistance (the DC of an action against it). Never more than -3 from the same curse (Q-212).
 */

const curse = (id = 'curse:Venom of Despair'): StatusEffect => ({
  id,
  label: 'หวาดกลัว',
  polarity: 'debuff',
  origin: 'curse',
  visible: true,
  mods: [{ scope: 'all', value: -3 }],
  phasesLeft: 4,
  ref: 'Venom of Despair',
});

function cursedActor(): ResolutionState {
  const s = baseState();
  return { ...s, actor: { ...s.actor, statuses: [curse()] } };
}

function withNpcCurse(npcId: string): ResolutionState {
  const s = baseState();
  return { ...s, npcs: { ...s.npcs, [npcId]: { ...s.npcs[npcId]!, statuses: [curse()] } } };
}

describe('GEN-095 curse on the holder\'s rolls (rules)', () => {
  it('C1: a cursed actor rolls -3 even without a stat claim, logged as a status modifier', () => {
    const r = resolveAction({ state: cursedActor(), proposal: proposal({ modifiers: [], check: { type: 'dc', dc: 11 } }) }, new ReplayRng([13]));
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (!r.ok) return;
    expect(r.log.check?.modifiers).toEqual([{ source: 'status', ref: 'curse:Venom of Despair', value: -3 }]);
    expect(r.log.check?.total).toBe(10);
    expect(r.log.degree).toBe('fail');
    expect(replayResolution(r.log)).toEqual(r);
  });

  it('C1: with a stat claim the curse counts once (not in stat and again as a status)', () => {
    const r = resolveAction({ state: cursedActor(), proposal: proposal({ modifiers: [{ source: 'stat' }] }) }, new ReplayRng([13]));
    if (!r.ok) return expect.fail(JSON.stringify(r.errors));
    expect(r.log.check?.modifierSum).toBe(-3);
    expect(r.log.check?.modifiers).toEqual([
      { source: 'stat', value: 0 },
      { source: 'status', ref: 'curse:Venom of Despair', value: -3 },
    ]);
  });

  it('an actor without a curse rolls as before (no status modifier)', () => {
    const r = resolveAction({ state: baseState(), proposal: proposal({ modifiers: [] }) }, new ReplayRng([13]));
    expect(r.ok && r.log.check?.modifiers).toEqual([]);
  });

  it('C4: a cursed NPC witness rolls -3 to notice a Secret', () => {
    const secret = proposal({ visibility: 'secret', witnessNpcIds: ['npc-guard'], check: { type: 'dc', dc: 8 } });
    const plain = resolveAction({ state: baseState(), proposal: secret }, new ReplayRng([10, 12]));
    const cursed = resolveAction({ state: withNpcCurse('npc-guard'), proposal: secret }, new ReplayRng([10, 12]));
    if (!plain.ok || !cursed.ok) return expect.fail('expected ok');
    // guard B: d20 12 + 1 = 13 > total 10 → caught; cursed: 12 + 1 - 3 = 10, not above 10 → unseen.
    expect(plain.log.observation).toEqual({ npcId: 'npc-guard', d20: 12, total: 13 });
    expect(plain.log.caught).toBe(true);
    expect(cursed.log.observation).toEqual({ npcId: 'npc-guard', d20: 12, total: 10 });
    expect(cursed.log.caught).toBe(false);
  });

  it('C4: an action against a cursed NPC meets a DC 3 lower (its resistance rolls -3), logged as targetCurse', () => {
    const against = proposal({ target: { npc: 'npc-guard' }, modifiers: [], check: { type: 'dc', dc: 14 } });
    const plain = resolveAction({ state: baseState(), proposal: against }, new ReplayRng([12]));
    const cursed = resolveAction({ state: withNpcCurse('npc-guard'), proposal: against }, new ReplayRng([12]));
    if (!plain.ok || !cursed.ok) return expect.fail('expected ok');
    expect([plain.log.check?.dc, plain.log.degree, plain.log.check?.targetCurse]).toEqual([14, 'fail', undefined]);
    expect([cursed.log.check?.dc, cursed.log.degree, cursed.log.check?.targetCurse]).toEqual([11, 'success', -3]);
    // A curse on another NPC changes nothing.
    const other = resolveAction({ state: withNpcCurse('npc-priest'), proposal: against }, new ReplayRng([12]));
    expect(other.ok && other.log.check?.dc).toBe(14);
  });
});

// --- Cross-player (PvP) ---

function player(id: string, seat: number, patch: Partial<PlayerState> = {}): PlayerState {
  return { id, seat, locationId: 'market', hp: 100, stamina: 30, rep: 0, karma: 0, affinity: {}, items: [], skills: [], statuses: [], afterActionStamina: 0, damageReduction: 0, remoteReach: [], ...patch };
}

const venom: TagSource = {
  id: 'skill-venom',
  kind: 'skill',
  rank: 'A',
  trigger: 'active',
  dailyLimit: 2,
  verbTags: ['CURSE', 'INTIMIDATE'],
  targetTags: ['NPC', 'PLAYER'],
  requireLocationTags: [],
  diceBonus: 0,
  diceBonusCap: null,
  targetDiceBonus: -3,
};
const tags = (): Record<string, TagContext> => ({ 'pc-a': { vocabulary: ['CURSE', 'INTIMIDATE', 'NPC', 'PLAYER'], sources: [venom], usesToday: {}, locationTags: [] } });
const none = { damage: null, heal: null, takeItem: null, giveItem: null };

/** A curses B with Venom (complex 5, pvp, Active 4 Stamina). Dice: A's priority, then the action d20. */
function venomPhase(b: PlayerState) {
  const state: CrossPlayerState = { players: { 'pc-a': player('pc-a', 0, { skills: [{ id: 'skill-venom', tier: 'Rare' }] }), 'pc-b': b }, npcs: {} };
  return resolvePhaseActions(
    {
      state,
      tags: tags(),
      actions: [
        {
          actorId: 'pc-a',
          proposal: proposal({
            actionId: 'act-a',
            kind: 'complex',
            staminaCost: 5,
            check: { type: 'pvp' },
            modifiers: [],
            onSuccess: noEffects(),
            tagging: { verbTags: ['CURSE'], targetTags: ['PLAYER'], activate: [{ ref: 'skill-venom', stamina: 4 }] },
          }),
          targetPlayer: { player: 'pc-b', intent: 'harm', reachRef: null, defenseRef: null, perceptionRef: null, onSuccess: none, onFail: none },
          moveTo: null,
          awareness: 'normal',
        },
      ],
    },
    new ReplayRng([10, 9]),
  );
}

describe('GEN-095 curse in a PvP check (rules)', () => {
  it('C5: casting Venom again on a cursed player lowers DC_pvp by 3 in all, not 6', () => {
    const r = venomPhase(player('pc-b', 1));
    const recast = venomPhase(player('pc-b', 1, { statuses: [curse()] }));
    if (!r.ok || !recast.ok) return expect.fail('expected ok');
    const dc = (x: typeof r) => {
      const o = x.log.outcomes[0]!;
      return o.status === 'resolved' ? o.log.check?.dc : null;
    };
    // First cast: Q-131 lowers DC_pvp 11 by Venom's -3 → 8.
    expect(dc(r)).toBe(8);
    // C5 / Q-212: casting again on a cursed B is still -3 in all (the curse in DC_pvp and Venom's own -3 do not add up).
    expect(dc(recast)).toBe(8);
  });
});

/** A attacks B with a plain PvP action (no Venom, no tag source). Dice: A's priority, then the action d20. */
function plainAttack(b: PlayerState, d20: number) {
  const state: CrossPlayerState = { players: { 'pc-a': player('pc-a', 0), 'pc-b': b }, npcs: {} };
  return resolvePhaseActions(
    {
      state,
      actions: [
        {
          actorId: 'pc-a',
          proposal: proposal({ actionId: 'act-a', kind: 'complex', staminaCost: 5, check: { type: 'pvp' }, modifiers: [], onSuccess: noEffects() }),
          targetPlayer: { player: 'pc-b', intent: 'harm', reachRef: null, defenseRef: null, perceptionRef: null, onSuccess: none, onFail: none },
          moveTo: null,
          awareness: 'normal',
        },
      ],
    },
    new ReplayRng([10, d20]),
  );
}

/** Nok's answers round 10 (Q-249, Q-250, Q-251): pinned as built, no behaviour change. */
describe('GEN-095 answers r10 (pins)', () => {
  const checkOf = (x: ReturnType<typeof plainAttack>) => {
    if (!x.ok) return expect.fail(JSON.stringify(x.errors));
    const o = x.log.outcomes[0]!;
    return o.status === 'resolved' ? { dc: o.log.check?.dc, degree: o.log.degree } : null;
  };

  it('Q-249: an action against a cursed NPC is 3 easier (DC 14 → 11): the same d20 that fell short now succeeds', () => {
    const against = proposal({ target: { npc: 'npc-guard' }, modifiers: [], check: { type: 'dc', dc: 14 } });
    const results = [baseState(), withNpcCurse('npc-guard')].map((state) => resolveAction({ state, proposal: against }, new ReplayRng([11])));
    expect(results.map((r) => r.ok && [r.log.check?.dc, r.log.degree])).toEqual([[14, 'fail'], [11, 'success']]);
  });

  it('Q-250: the curse also lowers its holder\'s defence: any PvP action against a cursed player meets DC_pvp 3 lower (11 → 8)', () => {
    // d20 9: short of 11 against a player without the curse, enough against 8.
    expect(checkOf(plainAttack(player('pc-b', 1), 9))).toEqual({ dc: 11, degree: 'fail' });
    expect(checkOf(plainAttack(player('pc-b', 1, { statuses: [curse()] }), 9))).toEqual({ dc: 8, degree: 'success' });
  });

  it('Q-251: Venom\'s -3 counts on the cast (Q-131) and afterwards as the status, never both: cast on a clean target 8, plain attack on a cursed one 8, recast on a cursed one 8 (not 5)', () => {
    const cast = venomPhase(player('pc-b', 1));
    const recast = venomPhase(player('pc-b', 1, { statuses: [curse()] }));
    expect([checkOf(cast)?.dc, checkOf(plainAttack(player('pc-b', 1, { statuses: [curse()] }), 9))?.dc, checkOf(recast)?.dc]).toEqual([8, 8, 8]);
  });
});
