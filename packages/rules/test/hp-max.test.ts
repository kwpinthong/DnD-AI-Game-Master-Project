import { describe, expect, it } from 'vitest';
import {
  createPhaseState,
  phaseStep,
  resolveAction,
  resolvePhaseActions,
  SeededRng,
  type CrossPlayerState,
  type PhaseState,
  type PlayerState,
} from '../src/index.ts';
import { baseState, noEffects, proposal } from './resolution-fixtures.ts';

/**
 * Q-210 (GEN-065): each character's Max HP (the start scenario's, e.g. 30 or 45) caps HP in the engine;
 * RULES.hpMax = 100 stays only as the fallback for an actor / player without one (old fixtures, old games).
 * A light heal is +8 (SEVERITY_BASE).
 */

const healSelf = proposal({ check: { type: 'none' }, modifiers: [], onSuccess: noEffects({ heal: 'light' }), onFail: noEffects({ heal: 'light' }) });

function selfHeal(hp: number, hpMax?: number) {
  const state = baseState();
  const actor = { ...state.actor, hp, ...(hpMax !== undefined ? { hpMax } : {}) };
  const result = resolveAction({ state: { ...state, actor }, proposal: healSelf }, new SeededRng(1));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.log.hp.actor.after;
}

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

function healOther(targetHp: number, targetMax?: number) {
  const state: CrossPlayerState = {
    players: {
      a: player('a', 0),
      b: player('b', 1, { hp: targetHp, ...(targetMax !== undefined ? { hpMax: targetMax } : {}) }),
    },
    npcs: {},
  };
  const result = resolvePhaseActions(
    {
      state,
      actions: [
        {
          actorId: 'a',
          proposal: proposal({ actionId: 'heal-b', check: { type: 'none' }, modifiers: [] }),
          targetPlayer: {
            player: 'b',
            intent: 'help',
            reachRef: null,
            defenseRef: null,
            perceptionRef: null,
            onSuccess: { damage: null, heal: 'light', takeItem: null, giveItem: null },
            onFail: { damage: null, heal: 'light', takeItem: null, giveItem: null },
          },
          moveTo: null,
          awareness: 'normal',
        },
      ],
    },
    new SeededRng(2),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.state.players.b!.hp;
}

/** One player resting through a NOCTHERION turn on rough ground (HP +5). */
function nightRest(hp: number, hpMax?: number): number {
  const base = createPhaseState({ players: [{ id: 'pc-a', hp, ...(hpMax !== undefined ? { hpMax } : {}) }] });
  const night: PhaseState = { ...base, phase: 'NOCTHERION' };
  const sent = phaseStep(night, { type: 'submit', playerId: 'pc-a', action: { text: 'นอน', visibility: 'public', rest: true } }, new SeededRng(3));
  if (!sent.ok) throw new Error(sent.error.code);
  const closed = phaseStep(sent.state, { type: 'resolved', results: {} }, new SeededRng(3));
  if (!closed.ok) throw new Error(closed.error.code);
  return closed.state.players['pc-a']!.hp;
}

describe('Q-210 the character Max HP caps HP in the engine', () => {
  it('a heal on yourself stops at your Max HP (30, 45); without one at 100', () => {
    expect(selfHeal(25, 30)).toBe(30);
    expect(selfHeal(40, 45)).toBe(45);
    expect(selfHeal(30, 45)).toBe(38);
    expect(selfHeal(95)).toBe(100);
  });

  it('a heal on another player stops at that player\'s Max HP', () => {
    expect(healOther(25, 30)).toBe(30);
    expect(healOther(40, 45)).toBe(45);
    expect(healOther(95)).toBe(100);
  });

  it('a night rest stops at the player\'s Max HP; a result above it is refused', () => {
    expect(nightRest(28, 30)).toBe(30);
    expect(nightRest(43, 45)).toBe(45);
    expect(nightRest(98)).toBe(100);

    const s = createPhaseState({ players: [{ id: 'pc-a', hp: 20, hpMax: 30 }] });
    const sent = phaseStep(s, { type: 'submit', playerId: 'pc-a', action: { text: 'เดิน', visibility: 'public' } }, new SeededRng(4));
    if (!sent.ok) throw new Error(sent.error.code);
    const over = phaseStep(sent.state, { type: 'resolved', results: { 'pc-a': { hp: 31 } } }, new SeededRng(4));
    expect(over.ok).toBe(false);
    expect(phaseStep(sent.state, { type: 'resolved', results: { 'pc-a': { hp: 30 } } }, new SeededRng(4)).ok).toBe(true);
  });
});
