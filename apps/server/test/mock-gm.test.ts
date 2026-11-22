import { describe, expect, it } from 'vitest';
import type { AiCallRequest } from '../src/ai/provider.ts';
import { checkNarration } from '../src/gm/check.ts';
import type { NarrationContext, TurnContext } from '../src/gm/context.ts';
import { cannedGmAnswer, mockAction, MOCK_BAD_NARRATION_MARKER } from '../src/gm/mock-gm.ts';
import type { GmNarration } from '../src/gm/schema.ts';

/** Dev marker of the Mock GM (Q-151 localhost check): a narration that never passes, so the template is used. */
describe('Mock GM [mock:badnarration]', () => {
  const ctx = (text: string): NarrationContext => ({
    kind: 'gm_narration',
    audience: { player: 'r1' },
    turn: { day: 1, phase: 'EOSORIA', turn: 1 },
    place: { id: 'inn', name: 'โรงเตี๊ยม' },
    cast: [{ ref: 'r1', looks: 'หญิงผ้าคลุมเทา', title: '', self: true }],
    npcs: [],
    beats: [{ actionId: 'act-1', kind: 'own_action', actor: 'r1', text, result: 'success', target: null, moved: null, items: [] }],
    journal: null,
  });
  const request = (c: NarrationContext, repair: boolean): AiCallRequest => ({
    purpose: 'narrate_player',
    model: 'mock',
    system: [],
    messages: [{ role: 'user', text: JSON.stringify(c) }, ...(repair ? [{ role: 'assistant' as const, text: '{}' }, { role: 'user' as const, text: '{}' }] : [])],
    output: { name: 'gm_narration', jsonSchema: {} },
    maxOutputTokens: 100,
    effort: 'low',
    timeoutMs: 1000,
  });

  it('fails the checks on the first try and on the repair', async () => {
    const c = ctx(`เช็ดโต๊ะ ${MOCK_BAD_NARRATION_MARKER}`);
    for (const repair of [false, true]) {
      const answer = (await cannedGmAnswer(request(c, repair))) as GmNarration;
      expect(checkNarration(c, answer, []).map((e) => e.code)).toContain('unknown_action');
    }
  });

  it('without the marker the answer passes', async () => {
    const c = ctx('เช็ดโต๊ะ');
    expect(checkNarration(c, (await cannedGmAnswer(request(c, false))) as GmNarration, [])).toEqual([]);
  });
});

/** GEN-070 dev markers for the localhost check: aim an action at a player with no roll. */
describe('Mock GM [mock:harm=ref] / [mock:execute=ref]', () => {
  const turn = (text: string) => ({ actions: [{ actionId: 'act-1', actor: 'r1', text }], tagVocabulary: ['ATTACK'] }) as unknown as TurnContext;

  it('a lethal hit or an EXECUTE on that ref, no roll; no marker = no target', () => {
    expect(mockAction(turn('ฟาด [mock:harm=Ab-9_x]'), 'act-1')).toMatchObject({
      check: { type: 'none' },
      targetPlayer: { player: 'Ab-9_x', intent: 'harm', onSuccess: { damage: 'lethal' } },
    });
    expect(mockAction(turn('ปลิดชีพ [mock:execute=Ab-9_x]'), 'act-1')).toMatchObject({ check: { type: 'none' }, targetPlayer: { player: 'Ab-9_x', intent: 'execute' } });
    expect(mockAction(turn('เดินเล่น'), 'act-1')).toMatchObject({ check: { type: 'dc', dc: 11 }, targetPlayer: null });
  });
});
