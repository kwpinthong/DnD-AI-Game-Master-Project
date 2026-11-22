import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropicProvider } from '../../src/ai/providers/anthropic.ts';
import { GM_OUTPUT, GmFinale, GmTurnProposal } from '../../src/gm/schema.ts';
import { startAnthropicStub, type AnthropicStub } from './anthropic-stub.ts';
import { aiConfig } from './fixtures.ts';

/**
 * GEN-059 Q-206 / Q-234: the real API refuses a structured-output schema that carries size constraints
 * ("For 'array' type, property 'maxItems' is not supported"; the same family: minLength / maxLength, minimum /
 * maximum, multipleOf). The provider sends the schema without them; the rules stay in the zod schema, which the
 * AI service applies to every answer (a breach is a schema_mismatch and is retried).
 */

/** Keywords the Messages API does not take in `output_config.format.schema`. */
const UNSUPPORTED = ['maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'pattern', 'default'];

/** Every schema keyword used anywhere in `schema` (property names of `properties` are not keywords). */
function keywordsOf(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const s of schema) keywordsOf(s, found);
  else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      found.add(key);
      if (key === 'properties' || key === '$defs') for (const sub of Object.values(value as object)) keywordsOf(sub, found);
      else if (key !== 'enum' && key !== 'const' && key !== 'required') keywordsOf(value, found);
    }
  }
  return found;
}

describe('Anthropic provider: the schema sent as output_config.format', () => {
  let stub: AnthropicStub | undefined;

  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  async function sentSchema(name: string, schema: z.ZodType): Promise<Record<string, unknown>> {
    stub = await startAnthropicStub();
    const provider = createAnthropicProvider(aiConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: stub.baseUrl }));
    await provider.call({
      purpose: 'gm_adjudicate',
      model: 'claude-sonnet-5-5',
      system: [{ id: 'rules', text: 'rules', cache: false }],
      messages: [{ role: 'user', text: 'go' }],
      output: { name, jsonSchema: z.toJSONSchema(schema) as Record<string, unknown> },
      maxOutputTokens: 1000,
      effort: 'low',
      timeoutMs: 5_000,
    });
    const format = (stub.requests[0]!.body.output_config as { format: { type: string; schema: Record<string, unknown> } }).format;
    expect(format.type).toBe('json_schema');
    return format.schema;
  }

  it.each([
    [GM_OUTPUT.turn, GmTurnProposal],
    [GM_OUTPUT.finale, GmFinale],
  ] as const)('%s: no size constraint the API refuses is sent', async (name, schema) => {
    const full = keywordsOf(z.toJSONSchema(schema));
    // The zod schema does carry such rules (that is what the API refused).
    expect(UNSUPPORTED.filter((k) => full.has(k)).length).toBeGreaterThan(0);
    const sent = keywordsOf(await sentSchema(name, schema));
    expect(UNSUPPORTED.filter((k) => sent.has(k))).toEqual([]);
  });

  it('the shape itself is kept: types, required, enum, anyOf with null, additionalProperties false', async () => {
    const sent = await sentSchema(GM_OUTPUT.turn, GmTurnProposal);
    const outcome = (sent.properties as Record<string, { items: Record<string, unknown> }>).eventOutcomes!.items;
    expect(outcome).toEqual({
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        outcome: { type: 'string' },
        side: { anyOf: [{ type: 'string', enum: ['good', 'evil', 'neutral'] }, { type: 'null' }] },
      },
      required: ['eventId', 'outcome', 'side'],
      additionalProperties: false,
    });
    expect(sent.required).toEqual(['actions', 'constraints', 'eventOutcomes', 'endingPath', 'remember']);
    expect(sent.$schema).toBeUndefined();
  });

  it('a property that is merely named like a constraint keeps its place', async () => {
    const sent = await sentSchema('odd', z.object({ maximum: z.number().int().max(5), pattern: z.string().max(3), items: z.array(z.string()).max(2) }));
    expect(sent).toEqual({
      type: 'object',
      properties: { maximum: { type: 'integer' }, pattern: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } },
      required: ['maximum', 'pattern', 'items'],
      additionalProperties: false,
    });
  });
});
