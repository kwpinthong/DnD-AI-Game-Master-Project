import { describe, expect, it } from 'vitest';
import type { AiCallRequest } from '../src/ai/provider.ts';
import { checkNarration } from '../src/gm/check.ts';
import type { NarrationContext } from '../src/gm/context.ts';
import { cannedGmAnswer, MOCK_BAD_NARRATION_MARKER } from '../src/gm/mock-gm.ts';
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
