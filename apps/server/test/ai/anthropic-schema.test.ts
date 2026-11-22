import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropicProvider } from '../../src/ai/providers/anthropic.ts';
import { providerFor } from '../../src/ai/registry.ts';
import { GM_OUTPUT, GmTurnProposal } from '../../src/gm/schema.ts';
import { startAnthropicStub, type AnthropicStub } from './anthropic-stub.ts';
import { aiConfig, makeService, trigger, usageRows, type ServiceHarness } from './fixtures.ts';

/**
 * GEN-059 Q-285: how the Anthropic provider asks for the answer. The real API (claude-sonnet-5-5) refused
 * GmTurnProposal as strict structured output three ways (maxItems, more than 16 union-typed parameters, "the
 * compiled grammar is too large") and refuses a forced tool ("tool_choice: type "tool" and "any" are not
 * supported for this model"). So the schema goes into the prompt and the answer is JSON text; the zod schema
 * in the AI service is the check, as for every provider.
 */
describe('Anthropic provider: the schema goes in the prompt, the answer is JSON text (Q-285)', () => {
  let stub: AnthropicStub | undefined;
  let harness: ServiceHarness | undefined;

  afterEach(async () => {
    harness?.cleanup();
    harness = undefined;
    await stub?.close();
    stub = undefined;
  });

  const anthropic = (extra: Record<string, string> = {}) => aiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: stub!.baseUrl, ...extra });

  async function callWith(answer: Parameters<typeof startAnthropicStub>[0]) {
    stub = await startAnthropicStub(answer);
    const provider = createAnthropicProvider(anthropic());
    const jsonSchema = z.toJSONSchema(GmTurnProposal) as Record<string, unknown>;
    const result = await provider.call({
      purpose: 'gm_adjudicate',
      model: 'claude-sonnet-5-5',
      system: [
        { id: 'rules', text: 'กฎ', cache: true },
        { id: 'state', text: 'สถานะ', cache: false },
      ],
      messages: [{ role: 'user', text: 'go' }],
      output: { name: GM_OUTPUT.turn, jsonSchema },
      maxOutputTokens: 1000,
      effort: 'low',
      timeoutMs: 5_000,
    });
    return { result, body: stub.requests[0]!.body, jsonSchema };
  }

  it('no structured output, no tool: the request carries the whole JSON schema as the last system block', async () => {
    const { body, jsonSchema } = await callWith({ kind: 'json', value: {} });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    const system = body.system as { type: string; text: string; cache_control?: unknown }[];
    // The caller's blocks keep their order and cache breakpoints; the schema block is added after them.
    expect(system.slice(0, 2)).toEqual([
      { type: 'text', text: 'กฎ', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'สถานะ' },
    ]);
    expect(system).toHaveLength(3);
    expect(system[2]!.text).toContain('JSON');
    const { $schema: _drop, ...schema } = jsonSchema;
    // The schema as zod wrote it, size rules included (nothing is stripped or rewritten any more).
    expect(system[2]!.text).toContain(JSON.stringify(schema));
    expect(system[2]!.text).toContain('"maxItems"');
    expect(system[2]!.text).toContain(GM_OUTPUT.turn);
  });

  it.each([
    ['plain JSON', '{"a":1,"b":[null,"x"]}'],
    ['a ```json fence', '```json\n{"a":1,"b":[null,"x"]}\n```'],
    ['a sentence around it', 'นี่คือคำตอบ:\n{"a":1,"b":[null,"x"]}\nจบ'],
  ])('the answer is read from %s', async (_name, text) => {
    const { result } = await callWith({ kind: 'text', text });
    expect(result).toMatchObject({ ok: true, json: { a: 1, b: [null, 'x'] } });
  });

  it('text with no JSON object in it is invalid_json (retryable), with its tokens counted', async () => {
    const { result } = await callWith({ kind: 'text', text: 'ขออภัย ตอบไม่ได้ {ยังไม่จบ' });
    expect(result).toMatchObject({ ok: false, error: 'invalid_json', retryable: true, usage: { inputTokens: 1200, outputTokens: 300 } });
  });

  const WRONG = { verdict: 'maybe', hp: 40 };
  const GOOD = { verdict: 'ok', note: 'เปิดได้' };

  it('an answer that breaks the schema is asked again once; still wrong: an error, and no further call', async () => {
    stub = await startAnthropicStub({ kind: 'json', value: GOOD });
    stub.queue({ kind: 'json', value: WRONG }, { kind: 'json', value: WRONG });
    const config = anthropic({ AI_MAX_RETRIES: '1' });
    harness = makeService(providerFor(config), config);

    const result = await harness.service.call(trigger('game-q285'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ai_unavailable');
    // Two calls and no third: the good answer waiting in the stub is never asked for.
    expect(stub.requests).toHaveLength(2);
    expect(usageRows(harness.opened.sqlite).map((row) => [row.ok, row.attempt, row.failure_reason?.split(':')[0]])).toEqual([
      [0, 1, 'schema_mismatch'],
      [0, 2, 'schema_mismatch'],
    ]);
  });

  it('wrong the first time, right the second: the second answer is the result', async () => {
    stub = await startAnthropicStub();
    stub.queue({ kind: 'json', value: WRONG }, { kind: 'text', text: `\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`` });
    const config = anthropic({ AI_MAX_RETRIES: '1' });
    harness = makeService(providerFor(config), config);

    expect(await harness.service.call(trigger('game-q285'))).toEqual({ ok: true, value: GOOD, attempts: 2 });
    expect(stub.requests).toHaveLength(2);
  });
});
