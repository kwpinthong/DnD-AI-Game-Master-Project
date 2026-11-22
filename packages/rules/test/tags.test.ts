import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SKILL_STAMINA,
  SeededRng,
  ReplayRng,
  matchingSources,
  replayResolution,
  resolveAction,
  type ResolutionState,
  type TagClaim,
  type TagContext,
  type TagSource,
} from '../src/index.ts';
import { baseState, proposal } from './resolution-fixtures.ts';

/**
 * GEN-064 tag matching. Sources mirror real rows of the asset sheet (GEN-062): Luminous Strike
 * (B, Active, Daily_Limit 3), Smite of Purgation (A, Active, 2), Feast of Malice (B, Passive,
 * dice_bonus +2), I AM UNTOUCHED (SS, Passive, ANY verb), a start passive "+2 PERSUADE in PUBLIC".
 */

const source = (patch: Partial<TagSource> & Pick<TagSource, 'id'>): TagSource => ({
  kind: 'skill',
  rank: 'B',
  trigger: 'passive',
  dailyLimit: 0,
  verbTags: [],
  targetTags: [],
  requireLocationTags: [],
  diceBonus: 0,
  diceBonusCap: null,
  ...patch,
});

const luminous = source({ id: 'skill-luminous', trigger: 'active', dailyLimit: 3, verbTags: ['ATTACK'], targetTags: ['NPC', 'MONSTER', 'EVIL_AFFILIATED'], diceBonus: 2 });
const smite = source({ id: 'skill-smite', rank: 'A', trigger: 'active', dailyLimit: 2, verbTags: ['ATTACK', 'PURGE'], targetTags: ['EVIL_AFFILIATED', 'NPC', 'PLAYER'] });
const feast = source({ id: 'skill-feast', verbTags: ['STEALTH', 'SABOTAGE', 'STEAL'], targetTags: ['SELF', 'SECRET_ACTION'], diceBonus: 2 });
const untouched = source({ id: 'skill-untouched', rank: 'SS', verbTags: ['DEFEND', 'OBSERVE', 'ESCAPE', 'ANY'], targetTags: ['SELF', 'MAGIC_EFFECT', 'MIND_CONTROL', 'DEBUFF'], diceBonus: 1 });
const lockpick = source({ id: 'item-lockpick', kind: 'item', verbTags: ['STEALTH', 'INFILTRATE', 'STEAL'], targetTags: ['LOCKED_DOOR', 'CHEST'], diceBonus: 1 });
const busker = source({ id: 'start:busker', kind: 'start_passive', rank: null, verbTags: ['PERSUADE', 'OBSERVE'], requireLocationTags: ['PUBLIC'], diceBonus: 2 });

const VOCABULARY = [
  'ATTACK', 'PURGE', 'NPC', 'MONSTER', 'EVIL_AFFILIATED', 'PLAYER', 'ALLY', 'SELF', 'SECRET_ACTION', 'STEALTH', 'SABOTAGE', 'STEAL',
  'DEFEND', 'OBSERVE', 'ESCAPE', 'MAGIC_EFFECT', 'MIND_CONTROL', 'DEBUFF', 'INFILTRATE', 'LOCKED_DOOR', 'CHEST', 'PERSUADE', 'PUBLIC', 'CROWD',
];

function ctx(patch: Partial<TagContext> = {}): TagContext {
  return {
    vocabulary: VOCABULARY,
    sources: [luminous, smite, feast, untouched, lockpick, busker],
    usesToday: {},
    locationTags: ['PUBLIC', 'CROWD'],
    ...patch,
  };
}

function state(): ResolutionState {
  const s = baseState();
  return {
    ...s,
    actor: {
      ...s.actor,
      skills: [...s.actor.skills, ...['skill-luminous', 'skill-smite', 'skill-feast', 'skill-untouched'].map((id) => ({ id, tier: 'Common' as const }))],
      items: [...s.actor.items, { id: 'item-lockpick', tier: 'Common' }],
    },
  };
}

const claim = (verbTags: string[], targetTags: string[], activate: TagClaim['activate'] = []): TagClaim => ({ verbTags, targetTags, activate });

/** An attack (complex, 5 Stamina) at DC 14 against the guard with this tag claim. */
function act(tagging: TagClaim, patch: Parameters<typeof proposal>[0] = {}) {
  return proposal({ kind: 'complex', staminaCost: 5, check: { type: 'dc', dc: 14 }, modifiers: [], target: { npc: 'npc-guard' }, tagging, ...patch });
}

const ids = (sources: readonly TagSource[]) => sources.map((s) => s.id);

describe('GEN-064 tag matching', () => {
  it('C1: Luminous Strike fits ATTACK on a MONSTER, not on an ALLY', () => {
    expect(ids(matchingSources(ctx(), ['ATTACK'], ['MONSTER']))).toContain('skill-luminous');
    expect(ids(matchingSources(ctx(), ['ATTACK'], ['ALLY']))).not.toContain('skill-luminous');
    expect(ids(matchingSources(ctx(), ['DEFEND'], ['MONSTER']))).not.toContain('skill-luminous');

    // Activating it where it does not fit is refused.
    const r = resolveAction({ state: state(), proposal: act(claim(['ATTACK'], ['ALLY'], [{ ref: 'skill-luminous', stamina: 4 }])), tags: ctx() }, new ReplayRng([10]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => [e.code, e.path])).toContainEqual(['tags_not_matched', 'tagging.activate[0].ref']);
  });

  it('C2: a tag that is not in the data (or ANY) rejects the whole proposal with a repairable error', () => {
    for (const [tagging, path] of [
      [claim(['SMASH'], ['MONSTER']), 'tagging.verbTags[0]'],
      [claim(['ATTACK'], ['MONSTER', 'DRAGON']), 'tagging.targetTags[1]'],
      [claim(['ANY'], ['MONSTER']), 'tagging.verbTags[0]'],
    ] as const) {
      const rng = new SeededRng(1);
      const r = resolveAction({ state: state(), proposal: act(tagging), tags: ctx() }, rng);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.errors.find((x) => x.path === path);
        expect(e?.code).toBe('unknown_tag');
        expect(e?.message).toMatch(/not a tag in the game data/);
      }
    }
    // A tag claim without the server's tag context cannot be checked, so it is refused too.
    const r = resolveAction({ state: state(), proposal: act(claim(['ATTACK'], ['MONSTER'])) }, new ReplayRng([10]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain('tagging');
  });

  it('C3: an Active skill with Daily_Limit 2 is refused the 3rd time on one day and works again the next day', () => {
    const use = (usesToday: Record<string, number>) =>
      resolveAction({ state: state(), proposal: act(claim(['ATTACK'], ['NPC'], [{ ref: 'skill-smite', stamina: 5 }])), tags: ctx({ usesToday }) }, new ReplayRng([10]));

    const second = use({ 'skill-smite': 1 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.log.tagging?.activated).toEqual([{ ref: 'skill-smite', stamina: 5, usesToday: 2 }]);

    const third = use({ 'skill-smite': 2 });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.errors.map((e) => [e.code, e.path])).toEqual([['daily_limit_reached', 'tagging.activate[0].ref']]);

    // The server keys uses by game day: a new day starts with no uses.
    const nextDay = use({});
    expect(nextDay.ok).toBe(true);
    if (nextDay.ok) expect(nextDay.log.tagging?.activated[0]?.usesToday).toBe(1);
  });

  it('C4: a matching Passive works on every action by itself, uses no quota, and cannot be activated', () => {
    const sneak = (usesToday: Record<string, number>) =>
      resolveAction(
        { state: state(), proposal: act(claim(['STEAL'], ['SECRET_ACTION']), { target: null, kind: 'general', staminaCost: 3 }), tags: ctx({ usesToday }) },
        new ReplayRng([10]),
      );
    for (const usesToday of [{}, { 'skill-feast': 99 }]) {
      const r = sneak(usesToday);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.log.tagging?.bonuses).toContainEqual({ kind: 'skill', ref: 'skill-feast', trigger: 'passive', value: 2 });
      expect(r.log.tagging?.activated).toEqual([]);
      expect(r.log.check?.modifiers).toContainEqual({ source: 'skill', ref: 'skill-feast', value: 2 });
      expect(r.log.check?.total).toBe(10 + 2);
    }
    // A passive that does not fit adds nothing.
    const off = resolveAction({ state: state(), proposal: act(claim(['ATTACK'], ['NPC'])), tags: ctx() }, new ReplayRng([10]));
    expect(off.ok && off.log.tagging?.bonuses.map((b) => b.ref)).toEqual([]);

    const r = resolveAction(
      { state: state(), proposal: act(claim(['STEAL'], ['SECRET_ACTION'], [{ ref: 'skill-feast', stamina: 4 }]), { target: null }), tags: ctx() },
      new ReplayRng([10]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('not_active');
  });

  it('C5: an Active skill costs the 4..6 Stamina the proposal states; -3 or -7 is refused', () => {
    expect(ACTIVE_SKILL_STAMINA).toEqual({ min: 4, max: 6 });
    for (const stamina of [4, 6]) {
      const r = resolveAction({ state: state(), proposal: act(claim(['ATTACK'], ['MONSTER'], [{ ref: 'skill-luminous', stamina }])), tags: ctx() }, new ReplayRng([10]));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.log.tagging?.skillStamina).toBe(stamina);
      expect(r.log.stamina.after).toBe(30 - 5 - stamina);
      expect(r.state.actor.stamina).toBe(30 - 5 - stamina);
    }
    for (const stamina of [3, 7, null]) {
      const r = resolveAction({ state: state(), proposal: act(claim(['ATTACK'], ['MONSTER'], [{ ref: 'skill-luminous', stamina }])), tags: ctx() }, new ReplayRng([10]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => [e.code, e.path])).toEqual([['out_of_range', 'tagging.activate[0].stamina']]);
    }
  });

  it('C6: ANY in Match_Verb_Tags fits every verb (the target tags still have to fit)', () => {
    for (const verb of ['ATTACK', 'PERSUADE', 'STEAL', 'INFILTRATE']) {
      expect(ids(matchingSources(ctx(), [verb], ['SELF']))).toContain('skill-untouched');
    }
    expect(ids(matchingSources(ctx(), ['ATTACK'], ['MONSTER']))).not.toContain('skill-untouched');
  });

  it('C7: a skill / item the actor does not have rejects the whole proposal and nothing changes', () => {
    const input = {
      state: state(),
      proposal: act(claim(['ATTACK'], ['MONSTER'], [{ ref: 'skill-luminous', stamina: 4 }, { ref: 'skill-stolen', stamina: 4 }])),
      tags: ctx(),
    };
    const before = JSON.stringify(input);
    const rng = new SeededRng(7);
    const r = resolveAction(input, rng);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => [e.code, e.path])).toEqual([['ref_not_owned', 'tagging.activate[1].ref']]);
    expect(JSON.stringify(input)).toBe(before);
    expect('state' in r).toBe(false);
    // Claiming a data-backed source as a judged modifier too would count it twice.
    const twice = resolveAction(
      { state: state(), proposal: act(claim(['ATTACK'], ['MONSTER'], [{ ref: 'skill-luminous', stamina: 4 }]), { modifiers: [{ source: 'skill', ref: 'skill-luminous', value: 2 }] }), tags: ctx() },
      new ReplayRng([10]),
    );
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.errors.map((e) => [e.code, e.path])).toEqual([['tag_source_judged', 'modifiers[0].ref']]);
  });

  it('C8: the log lists every bonus with its source (skill, item, location, weather, start passive), capped by Rank', () => {
    const weather = source({ id: 'weather:fountain:Clear', kind: 'weather', rank: null, verbTags: ['PERSUADE'], diceBonus: 2 });
    const place = source({ id: 'location:fountain', kind: 'location', rank: null, verbTags: ['PERSUADE'], targetTags: ['CROWD'], diceBonus: 1 });
    const charm = source({ id: 'item-charm', kind: 'item', rank: 'F', verbTags: ['PERSUADE'], diceBonus: 3 });
    const prism = source({ id: 'item-prism', kind: 'item', rank: 'B', trigger: 'active', dailyLimit: 3, verbTags: ['PERSUADE'], diceBonus: 3, diceBonusCap: 3 });
    const song = source({ id: 'skill-song', rank: 'B', trigger: 'active', dailyLimit: 3, verbTags: ['PERSUADE'], diceBonus: 4 });
    const s = state();
    const actor = { ...s.actor, items: [...s.actor.items, { id: 'item-charm', tier: 'Common' as const }, { id: 'item-prism', tier: 'Common' as const }], skills: [...s.actor.skills, { id: 'skill-song', tier: 'Common' as const }] };
    const tags = ctx({ sources: [weather, place, charm, prism, song, busker, luminous] });
    const p = act(claim(['PERSUADE'], ['CROWD'], [{ ref: 'item-prism', stamina: null }, { ref: 'skill-song', stamina: 4 }]), {
      kind: 'general',
      staminaCost: 3,
      target: null,
      modifiers: [{ source: 'stat' }],
    });
    const r = resolveAction({ state: { ...s, actor }, proposal: p, tags }, new ReplayRng([9]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.log.tagging?.bonuses).toEqual([
      { kind: 'weather', ref: 'weather:fountain:Clear', trigger: 'passive', value: 2 },
      { kind: 'location', ref: 'location:fountain', trigger: 'passive', value: 1 },
      { kind: 'item', ref: 'item-charm', trigger: 'passive', value: 1 }, // Rank F cap +1 (Q-122)
      { kind: 'item', ref: 'item-prism', trigger: 'active', value: 3 }, // Q-119 exception
      { kind: 'skill', ref: 'skill-song', trigger: 'active', value: 2 }, // Rank B cap +2 (Q-114)
      { kind: 'start_passive', ref: 'start:busker', trigger: 'passive', value: 2 },
    ]);
    expect(r.log.check?.modifiers).toEqual([
      { source: 'stat', value: 0 },
      { source: 'weather', ref: 'weather:fountain:Clear', value: 2 },
      { source: 'location', ref: 'location:fountain', value: 1 },
      { source: 'item', ref: 'item-charm', value: 1 },
      { source: 'item', ref: 'item-prism', value: 3 },
      { source: 'skill', ref: 'skill-song', value: 2 },
      { source: 'start_passive', ref: 'start:busker', value: 2 },
    ]);
    expect(r.log.check?.modifierTotal).toBe(10); // 11 clamped to the +/-10 total cap
    expect(r.log.tagging?.activated).toEqual([
      { ref: 'item-prism', stamina: 0, usesToday: 1 },
      { ref: 'skill-song', stamina: 4, usesToday: 1 },
    ]);
    // The start passive needs a PUBLIC place.
    const inside = resolveAction({ state: { ...s, actor }, proposal: p, tags: { ...tags, locationTags: ['INDOOR'] } }, new ReplayRng([9]));
    expect(inside.ok && inside.log.tagging?.bonuses.map((b) => b.ref)).not.toContain('start:busker');
    // The log replays.
    expect(replayResolution(r.log)).toEqual(r);
  });
});
