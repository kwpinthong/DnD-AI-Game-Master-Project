import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAnthropicProvider, forStructuredOutput, fromStructuredOutput } from '../../src/ai/providers/anthropic.ts';
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
        // Q-279: a nullable enum goes out as the enum plus "none" (see below).
        side: { type: 'string', enum: ['good', 'evil', 'neutral', 'none'] },
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

/**
 * Q-279: the API also refuses a schema with more than 16 union-typed parameters (GmTurnProposal has 25). The
 * provider sends a nullable enum as the enum plus the value "none" and turns "none" back into null in the
 * answer, before the AI service parses it with zod. The zod schemas, the checks and the mock do not change.
 */
describe('Anthropic provider: nullable enums as a "none" value (Q-279)', () => {
  /** Parameters the API counts as unions: `anyOf` or a list of types. */
  function unionCount(schema: unknown): number {
    if (Array.isArray(schema)) return schema.reduce<number>((n, s) => n + unionCount(s), 0);
    if (schema === null || typeof schema !== 'object') return 0;
    const own = 'anyOf' in schema || Array.isArray((schema as { type?: unknown }).type) ? 1 : 0;
    return own + Object.values(schema).reduce<number>((n, s) => n + unionCount(s), 0);
  }
  const Sample = z.object({
    severity: z.enum(['low', 'high']).nullable(),
    plain: z.enum(['a', 'b']),
    text: z.string().nullable(),
    already: z.enum(['none', 'some']).nullable(),
    nested: z.object({ severity: z.enum(['low', 'high']).nullable() }).nullable(),
    list: z.array(z.object({ severity: z.enum(['low', 'high']).nullable(), note: z.string() })),
    choice: z.union([z.object({ kind: z.literal('x'), severity: z.enum(['low', 'high']).nullable() }), z.object({ kind: z.literal('y'), severity: z.string() })]),
  });
  const sampleSchema = z.toJSONSchema(Sample);

  it('schema: a nullable enum becomes the enum plus "none"; other nullables and an enum that already has "none" stay as they are', () => {
    const sent = forStructuredOutput(sampleSchema) as { properties: Record<string, Record<string, unknown>> };
    expect(sent.properties.severity).toEqual({ type: 'string', enum: ['low', 'high', 'none'] });
    expect(sent.properties.plain).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(sent.properties.text).toEqual((sampleSchema.properties as Record<string, unknown>).text);
    expect(sent.properties.already).toEqual({ anyOf: [{ type: 'string', enum: ['none', 'some'] }, { type: 'null' }] });
    expect((sent.properties.list!.items as { properties: Record<string, unknown> }).properties.severity).toEqual({ type: 'string', enum: ['low', 'high', 'none'] });
  });

  it('GmTurnProposal sheds its 12 nullable enums and ends under the 16 union-typed parameters the API takes; GmFinale has none', () => {
    // This counter sees 26 where the API reported 25; either way 12 fewer is under the limit.
    expect(unionCount(z.toJSONSchema(GmTurnProposal))).toBe(26);
    expect(unionCount(forStructuredOutput(z.toJSONSchema(GmTurnProposal)))).toBe(14);
    expect(unionCount(forStructuredOutput(z.toJSONSchema(GmFinale)))).toBe(0);
  });

  it('answer: "none" becomes null exactly where the schema had a nullable enum, at any depth; every other "none" stays', () => {
    const answer = {
      severity: 'none',
      plain: 'a',
      text: 'none',
      already: 'none',
      nested: { severity: 'none' },
      list: [{ severity: 'none', note: 'none' }, { severity: 'high', note: 'x' }],
      choice: { kind: 'y', severity: 'none' },
    };
    const decoded = fromStructuredOutput(sampleSchema, answer);
    expect(decoded).toEqual({
      severity: null,
      plain: 'a',
      text: 'none',
      already: 'none',
      nested: { severity: null },
      list: [{ severity: null, note: 'none' }, { severity: 'high', note: 'x' }],
      choice: { kind: 'y', severity: 'none' },
    });
    expect(Sample.safeParse(decoded).success).toBe(true);
    expect(fromStructuredOutput(sampleSchema, { ...answer, nested: null, choice: { kind: 'x', severity: 'none' } })).toMatchObject({ nested: null, choice: { kind: 'x', severity: null } });
  });

  it('round trip through the provider: an answer written against the sent schema parses with the zod GmTurnProposal', async () => {
    const none = { damage: 'none', heal: 'none', takeItem: null, giveItem: null };
    const effects = { repDelta: 0, karmaDelta: 0, affinity: [], damage: 'none', selfDamage: 'none', heal: 'light', addStatus: [], removeStatus: [] };
    const light = GmTurnProposal.shape.actions.element.shape.onSuccess.shape.heal.unwrap().options[0];
    const answer = {
      actions: [
        {
          actionId: 'act-1', actor: 'p1', kind: 'general', tags: [], opposed: false, staminaCost: 3,
          check: { type: 'pvp' }, modifiers: [{ source: 'stat' }], targetNpc: null,
          targetPlayer: { player: 'p2', intent: 'help', defenseRef: null, perceptionRef: null, onSuccess: none, onFail: none },
          witnessNpcIds: [], repDeltaIfCaught: 0, onSuccess: { ...effects, heal: light }, onFail: effects,
          tagging: { verbTags: [], targetTags: [], activate: [] }, moveTo: null, awareness: 'normal', investigate: false,
          skillFlags: [], grants: [], strategy: null, intentSummary: '{{p:p1}} helps', reason: 'none',
        },
      ],
      constraints: { add: [], release: [] },
      eventOutcomes: [{ eventId: 'd5-disaster', outcome: 'อพยพได้ทัน', side: 'none' }, { eventId: 'd7-kidnapping', outcome: 'ช่วยได้', side: 'good' }],
      endingPath: 'none',
      remember: [],
    };
    const stub = await startAnthropicStub({ kind: 'json', value: answer });
    try {
      const provider = createAnthropicProvider(aiConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: stub.baseUrl }));
      const result = await provider.call({
        purpose: 'gm_adjudicate', model: 'claude-sonnet-5-5', system: [{ id: 'rules', text: 'rules', cache: false }], messages: [{ role: 'user', text: 'go' }],
        output: { name: GM_OUTPUT.turn, jsonSchema: z.toJSONSchema(GmTurnProposal) as Record<string, unknown> }, maxOutputTokens: 1000, effort: 'low', timeoutMs: 5_000,
      });
      if (!result.ok) return expect.fail(result.detail);
      const parsed = GmTurnProposal.safeParse(result.json);
      expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
      if (!parsed.success) return;
      const action = parsed.data.actions[0]!;
      expect([action.onFail.damage, action.onFail.selfDamage, action.onSuccess.heal, action.targetPlayer?.onSuccess.damage]).toEqual([null, null, light, null]);
      expect(parsed.data.eventOutcomes.map((e) => e.side)).toEqual([null, 'good']);
      expect(parsed.data.endingPath).toBeNull();
      // A free text that says "none" is not an enum: it stays.
      expect(action.reason).toBe('none');
    } finally {
      await stub.close();
    }
  });
});
