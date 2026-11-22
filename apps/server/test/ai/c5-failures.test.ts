import { afterEach, describe, expect, it } from 'vitest';
import { AiServiceError, AI_GM_UNAVAILABLE } from '../../src/ai/core/service.ts';
import { createMockProvider, mockReply } from '../../src/ai/providers/mock.ts';
import { providerFor } from '../../src/ai/registry.ts';
import { startAnthropicStub, type AnthropicStub } from './anthropic-stub.ts';
import { aiConfig, makeService, trigger, usageRows, type ServiceHarness } from './fixtures.ts';

const GOOD = { verdict: 'ok', note: 'เปิดได้' };

// GEN-038 C5: Given the provider times out, refuses or returns bad JSON / Then retry as configured,
// the room shows "AI GM ไม่ตอบ ลองอีกครั้ง", and AiUsage records ok=0.
describe('C5 timeout, refusal, bad JSON', () => {
  let harness: ServiceHarness | undefined;
  let stub: AnthropicStub | undefined;

  afterEach(async () => {
    harness?.cleanup();
    harness = undefined;
    await stub?.close();
    stub = undefined;
  });

  it('retries AI_MAX_RETRIES times, then gives the room the Thai message; every attempt is an ok=0 row', async () => {
    const config = aiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '2' });
    const mock = createMockProvider(config, {
      steps: [mockReply.fail('timeout'), mockReply.fail('refusal'), mockReply.fail('invalid_json')],
    });
    harness = makeService(mock, config);

    const result = await harness.service.call(trigger('game-c5'));

    expect(AI_GM_UNAVAILABLE).toBe('AI GM ไม่ตอบ ลองอีกครั้ง');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AiServiceError);
      expect(result.error.code).toBe('ai_unavailable');
      expect(result.error.audience).toBe('room');
      expect(result.error.message).toBe('AI GM ไม่ตอบ ลองอีกครั้ง');
    }
    expect(mock.requests).toHaveLength(3);
    const rows = usageRows(harness.opened.sqlite);
    expect(rows.map((row) => [row.ok, row.attempt, row.failure_reason?.split(':')[0]])).toEqual([
      [0, 1, 'timeout'],
      [0, 2, 'refusal'],
      [0, 3, 'invalid_json'],
    ]);
  });

  it('JSON that parses but breaks the schema counts as bad JSON and is retried', async () => {
    const config = aiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '1' });
    const mock = createMockProvider(config, {
      steps: [mockReply.ok({ verdict: 'maybe', hp: 40 }), mockReply.ok(GOOD)],
    });
    harness = makeService(mock, config);

    const result = await harness.service.call(trigger());

    expect(result).toMatchObject({ ok: true, value: GOOD, attempts: 2 });
    expect(usageRows(harness.opened.sqlite).map((row) => [row.ok, row.failure_reason?.split(':')[0] ?? null])).toEqual([
      [0, 'schema_mismatch'],
      [1, null],
    ]);
  });

  it('AI_MAX_RETRIES=0 means one attempt only', async () => {
    const config = aiConfig({ AI_PROVIDER: 'mock', AI_MAX_RETRIES: '0' });
    const mock = createMockProvider(config, { steps: [mockReply.fail('timeout'), mockReply.ok(GOOD)] });
    harness = makeService(mock, config);
    const result = await harness.service.call(trigger());
    expect(result.ok).toBe(false);
    expect(mock.requests).toHaveLength(1);
  });

  it('the Anthropic adapter turns a slow answer, a refusal and non-JSON text into timeout / refusal / invalid_json', async () => {
    stub = await startAnthropicStub();
    stub.queue(
      { kind: 'delay', ms: 2_000, then: { kind: 'json', value: GOOD } },
      { kind: 'refusal' },
      { kind: 'text', text: 'ขออภัย ฉันตอบเป็น JSON ไม่ได้' },
    );
    const config = aiConfig({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key-not-real',
      ANTHROPIC_BASE_URL: stub.baseUrl,
      AI_TIMEOUT_MS: '300',
      AI_MAX_RETRIES: '2',
    });
    harness = makeService(providerFor(config), config);

    const result = await harness.service.call(trigger('game-c5'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('AI GM ไม่ตอบ ลองอีกครั้ง');
    expect(stub.requests).toHaveLength(3);
    expect(usageRows(harness.opened.sqlite).map((row) => [row.ok, row.failure_reason?.split(':')[0]])).toEqual([
      [0, 'timeout'],
      [0, 'refusal'],
      [0, 'invalid_json'],
    ]);
  });

  it('the Anthropic adapter sends the effort, cache breakpoints, the configured model and no SDK-side retries (Q-285: no structured output, no tool)', async () => {
    stub = await startAnthropicStub({ kind: 'json', value: GOOD, usage: { input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 200 } });
    const config = aiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_BASE_URL: stub.baseUrl });
    harness = makeService(providerFor(config), config);

    const result = await harness.service.call(trigger());

    expect(result.ok).toBe(true);
    const sent = stub.requests[0]!;
    expect(sent.headers['x-api-key'] ?? sent.headers.authorization).toMatch(/^(?:Bearer )?test-key-not-real$/);
    expect(sent.body.model).toBe('claude-sonnet-5-5');
    expect(sent.body).toMatchObject({
      output_config: { effort: 'medium' },
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }, { type: 'text' }],
    });
    expect(sent.body.output_config).not.toHaveProperty('format');
    expect(sent.body).not.toHaveProperty('tools');
    expect(sent.body).not.toHaveProperty('tool_choice');
    const [row] = usageRows(harness.opened.sqlite);
    // claude-sonnet-5-5: 2 USD/M input, 0.10 cached, 10 output → 1000*2 + 4000*0.1 + 200*10 micro-USD.
    expect(row).toMatchObject({ input_tokens: 1000, cached_input_tokens: 4000, output_tokens: 200, cost_usd_micros: 4400 });
  });

  it('an auth error (401) is not retried', async () => {
    stub = await startAnthropicStub({ kind: 'status', status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const config = aiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_BASE_URL: stub.baseUrl, AI_MAX_RETRIES: '2' });
    harness = makeService(providerFor(config), config);
    const result = await harness.service.call(trigger());
    expect(result.ok).toBe(false);
    expect(stub.requests).toHaveLength(1);
    expect(usageRows(harness.opened.sqlite)[0]!.failure_reason).toMatch(/^provider_error/);
  });
});
