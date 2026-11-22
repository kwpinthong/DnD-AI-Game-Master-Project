import { describe, expect, it } from 'vitest';
import { earnedSkillChanges } from '../src/gm/skill-grants.ts';
import type { GmTurnProposal } from '../src/gm/schema.ts';
import { RULES_BLOCK } from '../src/gm/context.ts';
import { SKILL_FLAGS } from '../src/skills/unlock-rules.ts';

/** Q-180: only an action that succeeded (success / crit) earns its skillFlags and grants. */

const action = (actionId: string, actor: string, flags: string[], grants: GmTurnProposal['actions'][number]['grants'] = []) =>
  ({ actionId, actor, skillFlags: flags, grants }) as unknown as GmTurnProposal['actions'][number];

const proposal = (actions: GmTurnProposal['actions']): GmTurnProposal => ({ actions, constraints: { add: [], release: [] }, eventOutcomes: [], endingPath: null, remember: [] });

describe('earnedSkillChanges (Q-180)', () => {
  it('keeps success and crit, drops fail, fumble, skipped and no_target', () => {
    const censer = [{ kind: 'item' as const, name: 'Censer of Purging Flame', npcId: 'noble' }];
    const p = proposal([
      action('act-1', 'p1', ['protected_others'], censer),
      action('act-2', 'p2', ['defeated_evil']),
      action('act-3', 'p3', ['exposed_lie']),
      action('act-4', 'p4', ['sowed_discord']),
      action('act-5', 'p5', ['framed_someone']),
      action('act-6', 'p6', []),
    ]);
    const results: Record<string, string> = { 'act-1': 'success', 'act-2': 'crit', 'act-3': 'fail', 'act-4': 'fumble', 'act-5': 'skipped', 'act-6': 'success' };
    expect(earnedSkillChanges(p, (id) => results[id])).toEqual([
      { actionId: 'act-1', actor: 'p1', flags: ['protected_others'], grants: censer },
      { actionId: 'act-2', actor: 'p2', flags: ['defeated_evil'], grants: [] },
    ]);
  });

  it('the GM rules prompt names skillFlags / grants and every flag the unlock rules use', () => {
    expect(RULES_BLOCK.text).toContain('skillFlags');
    expect(RULES_BLOCK.text).toContain('grants');
    for (const flag of SKILL_FLAGS) expect(RULES_BLOCK.text).toContain(flag);
  });

  it('a stored proposal from before Q-180 (no fields) earns nothing', () => {
    const old = proposal([{ actionId: 'act-1', actor: 'p1' } as unknown as GmTurnProposal['actions'][number]]);
    expect(earnedSkillChanges(old, () => 'success')).toEqual([]);
  });
});
