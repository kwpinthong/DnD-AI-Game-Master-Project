import { describe, expect, it } from 'vitest';
import { loadAiConfig } from '../../src/ai/config.ts';
import { providerFor } from '../../src/ai/registry.ts';
import type { AiCallRequest } from '../../src/ai/provider.ts';

/** Q-177 dev knob: AI_MOCK_FAIL makes the offline Mock fail chosen purposes, to see the template fallback on localhost. */

const request = (purpose: AiCallRequest['purpose']): AiCallRequest => ({
  purpose,
  model: 'claude-sonnet-5-5',
  system: [{ id: 'rules', text: 'x', cache: false }],
  messages: [{ role: 'user', text: '{}' }],
  output: { name: 'gm_narration', jsonSchema: { type: 'object', properties: {}, required: [] } },
  maxOutputTokens: 10,
  effort: 'low',
  timeoutMs: 1000,
});

describe('AI_MOCK_FAIL (Q-177)', () => {
  it('fails the listed purposes with the listed error and answers the rest', async () => {
    const config = loadAiConfig({ AI_PROVIDER: 'mock', AI_MOCK_FAIL: 'narrate_player:timeout, narrate_place:provider_error' });
    expect(config.mockFail).toEqual({ narrate_player: 'timeout', narrate_place: 'provider_error' });
    const mock = providerFor(config);
    expect(await mock.call(request('narrate_player'))).toMatchObject({ ok: false, error: 'timeout', retryable: true });
    expect(await mock.call(request('narrate_place'))).toMatchObject({ ok: false, error: 'provider_error' });
    expect(await mock.call(request('gm_weather'))).toMatchObject({ ok: true });
  });

  it('is empty by default and refuses a value it does not know, naming the variable', () => {
    expect(loadAiConfig({ AI_PROVIDER: 'mock' }).mockFail).toEqual({});
    expect(() => loadAiConfig({ AI_MOCK_FAIL: 'narrate_player:slow' })).toThrow(/AI_MOCK_FAIL/);
    expect(() => loadAiConfig({ AI_MOCK_FAIL: 'dance:timeout' })).toThrow(/AI_MOCK_FAIL/);
  });
});
