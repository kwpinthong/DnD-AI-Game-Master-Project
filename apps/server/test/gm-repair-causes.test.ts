import { validateTagging, type TagContext } from '@isekai/rules';
import { describe, expect, it } from 'vitest';
import { checkTurnProposal } from '../src/gm/check.ts';
import { RULES_BLOCK } from '../src/gm/context.ts';
import { GmTurnProposal } from '../src/gm/schema.ts';

/**
 * GEN-118: why a real adjudicate needs a repair (GEN-115 run, 2 of 10 turns, both missing_action, one of the ones before it not_active).
 * missing_action: the real AI answered only the actions it thought had a mechanical effect. Captured answer of a 4-action turn
 * ("ใช้ไอเทมช่วยเพื่อนที่ดูเหนื่อย" with no named friend): 1 entry, act-1 with "ไม่มีผลเชิงกลไก", and nothing for act-2..act-4.
 * not_active: the AI lists a Passive skill / item in `tagging.activate`; only Active (or both) sources are activated.
 */
const text = (s: string) => s.replace(/\r\n/g, '\n');

describe('GEN-118 causes of the adjudicate repair', () => {
  it('C1 missing_action: a proposal that answers only act-1 of four is refused for the other three (the real answer)', () => {
    const effects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };
    const proposal = GmTurnProposal.parse({
      actions: [
        {
          actionId: 'act-1', actor: 'r1', kind: 'general', tags: ['social'], opposed: false, staminaCost: 3, check: { type: 'none' }, modifiers: [],
          targetNpc: null, targetPlayer: null, witnessNpcIds: [], repDeltaIfCaught: 0, onSuccess: effects, onFail: effects,
          tagging: { verbTags: [], targetTags: [], activate: [] }, moveTo: null, awareness: 'normal', investigate: false,
          intentSummary: 'ช่วยเพื่อน', reason: 'ไม่มีผลเชิงกลไก',
        },
      ],
      constraints: { add: [], release: [] }, eventOutcomes: [], endingPath: null, remember: [],
    });
    const order = ['act-1', 'act-2', 'act-3', 'act-4'].map((actionId, i) => ({ actionId, memberId: `m${i + 1}`, text: 'x', visibility: 'public' as const }));
    const world = { byRef: new Map([['r1', { memberId: 'm1' }]]), players: new Map(), places: [] };
    const r = checkTurnProposal(
      { world, state: { players: {} }, tags: {}, order, activeEventIds: new Set(), activeConstraintIds: new Set(), finaleActive: false, strategies: { known: new Set(), active: new Set() } } as never,
      proposal,
    );
    expect(r.ok).toBe(false);
    const missing = !r.ok ? r.errors.filter((e) => e.code === 'missing_action').map((e) => e.message) : [];
    expect(missing).toHaveLength(3);
  });

  it('C1 not_active: activating a Passive source is refused', () => {
    const ctx: TagContext = {
      vocabulary: ['PERSUADE'], locationTags: [], usesToday: {},
      sources: [{ id: 'skill-x', kind: 'skill', rank: 'B', trigger: 'passive', dailyLimit: 0, verbTags: ['PERSUADE'], targetTags: [], requireLocationTags: [], diceBonus: 1, diceBonusCap: null }],
    } as unknown as TagContext;
    const errors = validateTagging(ctx, { verbTags: ['PERSUADE'], targetTags: [], activate: [{ ref: 'skill-x', stamina: 2 }] } as never, []);
    expect(errors.map((e) => e.code)).toContain('not_active');
  });

  it('C2 the rules text tells the AI both: every order id gets an entry even with no effect, and a passive source is never activated', () => {
    const rules = text(RULES_BLOCK.text);
    expect(rules).toMatch(/แม้ไม่มีผลเชิงกลไก/);
    expect(rules).toMatch(/trigger = passive/);
    expect(rules).toMatch(/สั้น/);
  });
});
