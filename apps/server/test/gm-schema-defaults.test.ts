import { describe, expect, it } from 'vitest';
import { createAiService } from '../src/ai/core/service.ts';
import type { AiCallRequest, AiProvider } from '../src/ai/provider.ts';
import { GM_OUTPUT, GmTurnProposal } from '../src/gm/schema.ts';
import { aiConfig } from './ai/fixtures.ts';

/**
 * GEN-158: the adjudicate answer may leave out every field whose value is its zod default (0 / null / [] / false),
 * so the AI writes ~half the tokens. The parsed proposal must be exactly what the full answer gave before.
 */
const NO_EFFECTS = { repDelta: 0, karmaDelta: 0, affinity: [], damage: null, selfDamage: null, heal: null, addStatus: [], removeStatus: [] };

const FULL = {
  actions: [
    {
      actionId: 'a1',
      actor: 'p_a',
      kind: 'general',
      tags: [],
      opposed: false,
      staminaCost: 0,
      check: { type: 'none' },
      modifiers: [],
      targetNpc: null,
      targetPlayer: null,
      looksAt: [],
      witnessNpcIds: [],
      repDeltaIfCaught: 0,
      onSuccess: NO_EFFECTS,
      onFail: NO_EFFECTS,
      tagging: { verbTags: [], targetTags: [], activate: [] },
      moveTo: null,
      awareness: 'normal',
      investigate: false,
      skillFlags: [],
      grants: [],
      strategy: null,
      intentSummary: '{{p:p_a}} มองรอบๆ',
      reason: 'ไม่มีผลเชิงกลไก',
    },
    {
      actionId: 'a2',
      actor: 'p_b',
      kind: 'general',
      tags: [],
      opposed: false,
      staminaCost: 1,
      check: { type: 'dc', dc: 12 },
      modifiers: [{ source: 'stat' }],
      targetNpc: null,
      targetPlayer: {
        player: 'p_a',
        intent: 'harm',
        defenseRef: null,
        perceptionRef: null,
        onSuccess: { damage: 'light', heal: null, takeItem: null, giveItem: null },
        onFail: { damage: null, heal: null, takeItem: null, giveItem: null },
      },
      looksAt: [],
      witnessNpcIds: [],
      repDeltaIfCaught: 0,
      onSuccess: { ...NO_EFFECTS, repDelta: -1 },
      onFail: NO_EFFECTS,
      tagging: { verbTags: [], targetTags: [], activate: [] },
      moveTo: null,
      awareness: 'normal',
      investigate: false,
      skillFlags: [],
      grants: [],
      strategy: null,
      intentSummary: '{{p:p_b}} ต่อย {{p:p_a}}',
      reason: '',
    },
  ],
  constraints: { add: [], release: [] },
  eventOutcomes: [],
  endingPath: null,
  remember: [],
};

const MINIMAL = {
  actions: [
    { actionId: 'a1', actor: 'p_a', kind: 'general', staminaCost: 0, check: { type: 'none' }, awareness: 'normal', intentSummary: '{{p:p_a}} มองรอบๆ', reason: 'ไม่มีผลเชิงกลไก' },
    {
      actionId: 'a2',
      actor: 'p_b',
      kind: 'general',
      staminaCost: 1,
      check: { type: 'dc', dc: 12 },
      modifiers: [{ source: 'stat' }],
      targetPlayer: { player: 'p_a', intent: 'harm', onSuccess: { damage: 'light' } },
      onSuccess: { repDelta: -1 },
      awareness: 'normal',
      intentSummary: '{{p:p_b}} ต่อย {{p:p_a}}',
      reason: '',
    },
  ],
};

describe('GEN-158 adjudicate answer: fields with a default may be left out', () => {
  it('C1: a minimal answer parses to exactly what the full answer gives', () => {
    const full = GmTurnProposal.parse(FULL);
    expect(GmTurnProposal.parse(MINIMAL)).toEqual(full);
    expect(full).toEqual(FULL);
  });

  it('validation is not weakened: a wrong value in a defaulted field still fails', () => {
    const bad = structuredClone(MINIMAL) as { actions: Record<string, unknown>[] };
    bad.actions[0]!.onFail = { repDelta: 1.5 };
    expect(GmTurnProposal.safeParse(bad).success).toBe(false);
    const missing = structuredClone(MINIMAL) as { actions: Record<string, unknown>[] };
    delete missing.actions[0]!.intentSummary;
    expect(GmTurnProposal.safeParse(missing).success).toBe(false);
  });

  it('the JSON schema sent to the AI marks defaulted fields optional (input side), with their default', async () => {
    let sent: AiCallRequest | undefined;
    const provider: AiProvider = {
      id: 'mock',
      estimateTokens: () => 1,
      ready: () => ({ ok: true }),
      async call(req) {
        sent = req;
        return { ok: true, json: MINIMAL, usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, model: 'm', latencyMs: 1 };
      },
    };
    const usage = { spentThisMonth: () => 0, record: () => {} } as unknown as Parameters<typeof createAiService>[0]['usage'];
    const service = createAiService({ provider, config: aiConfig({ AI_PROVIDER: 'mock' }), usage, log: () => {} });
    const result = await service.call({
      gameId: 'g',
      purpose: 'gm_adjudicate',
      system: [],
      messages: [{ role: 'user', text: 'go' }],
      output: { name: GM_OUTPUT.turn, schema: GmTurnProposal },
      maxOutputTokens: 100,
    });
    expect(result).toMatchObject({ ok: true, value: GmTurnProposal.parse(FULL) });

    type Obj = { required?: string[]; properties: Record<string, Obj & { default?: unknown }>; items?: Obj };
    const root = sent!.output.jsonSchema as unknown as Obj;
    const action = root.properties.actions!.items!;
    expect(action.required).toEqual(expect.arrayContaining(['actionId', 'actor', 'kind', 'check', 'intentSummary', 'reason']));
    for (const key of ['tags', 'modifiers', 'targetNpc', 'targetPlayer', 'witnessNpcIds', 'onSuccess', 'onFail', 'tagging', 'moveTo', 'investigate', 'looksAt']) {
      expect(action.required, key).not.toContain(key);
    }
    const effects = action.properties.onSuccess!;
    expect(effects.required ?? []).toEqual([]);
    expect(effects.properties.repDelta!.default).toBe(0);
    expect(root.required).toEqual(['actions']);
  });
});
