import type { AiConfig } from '../config.ts';
import type { AiCallRequest, AiCallResult, AiErrorKind, AiProvider, AiTokenUsage } from '../provider.ts';

/** Answers a request the unscripted Mock knows a better reply to (the Mock GM, GEN-057); undefined = the schema sample. */
export type MockAnswerer = (req: AiCallRequest) => unknown;

/**
 * Mock provider for tests and offline dev (AI_PROVIDER=mock). It never touches the network.
 * With a script it answers step by step and fails loudly when the script runs out (a test bug).
 * Without one it answers every call with the smallest JSON that fits the requested schema.
 */
export interface MockScript {
  steps: (AiCallResult | ((req: AiCallRequest) => AiCallResult))[];
}

export interface MockProvider extends AiProvider {
  /** Every request received, for tests to assert what the context held. */
  readonly requests: AiCallRequest[];
}

const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export function createMockProvider(_config: AiConfig, script?: MockScript, answer?: MockAnswerer): MockProvider {
  const requests: AiCallRequest[] = [];
  const steps = script ? [...script.steps] : undefined;

  return {
    id: 'mock',
    requests,
    ready: () => ({ ok: true }),
    estimateTokens,
    async call(req) {
      requests.push(req);
      if (!steps) {
        const input = estimateTokens([...req.system.map((b) => b.text), ...req.messages.map((m) => m.text)].join('\n'));
        const json =
          req.purpose === 'character_analyze' ? cannedLoot(req, requests.length) : ((await answer?.(req)) ?? sampleFor(req.output.jsonSchema));
        return {
          ok: true,
          json,
          model: req.model,
          latencyMs: 0,
          usage: { inputTokens: input, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: estimateTokens(JSON.stringify(json)) },
        };
      }
      const step = steps.shift();
      if (step === undefined) throw new Error(`mock script ran out at request ${requests.length} (${req.purpose})`);
      const result = typeof step === 'function' ? step(req) : step;
      return result.ok ? { ...result, model: result.model || req.model } : result;
    },
  };
}

/** Ready-made script steps. */
export const mockReply = {
  ok(json: unknown, usage: AiTokenUsage = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }): AiCallResult {
    return { ok: true, json, usage, model: '', latencyMs: 0 };
  },
  fail(error: AiErrorKind, usage: AiTokenUsage | null = null): AiCallResult {
    return { ok: false, error, detail: `mock ${error}`, usage, retryable: true, latencyMs: 0 };
  },
};

/**
 * A loot answer for offline dev (GEN-048, GEN-073): the smallest schema sample has no options, so
 * the loot step would always fail. It picks names from the Rank B catalogue lines in the prompt
 * (`skill: <Name> | ...`, `item: <Name> | ...`, see game/loot.ts `lootCatalogue`); call n starts
 * one row further, so a reroll shows a different set.
 */
function cannedLoot(req: AiCallRequest, n: number) {
  const lines = req.system.flatMap((b) => b.text.split('\n'));
  const names = (kind: string) => lines.filter((l) => l.startsWith(`${kind}: `)).map((l) => l.slice(kind.length + 2).split(' | ')[0]!);
  const pick = (pool: string[]) => (pool.length === 0 ? [] : [...new Set([0, 1, 2].map((i) => pool[(n - 1 + i) % pool.length]!))]);
  return {
    strength: { label: 'ช่างสังเกต', scope: 'observe', description: 'บุคลิกบอกว่าคอยมองรายละเอียดรอบตัว' },
    weakness: { label: 'ลังเล', scope: 'priority', description: 'คิดนานก่อนลงมือ' },
    skills: pick(names('skill')),
    items: pick(names('item')),
  };
}

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
};

/** The smallest value that fits a JSON schema (as z.toJSONSchema writes them). */
export function sampleFor(schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const options = schema.anyOf ?? schema.oneOf;
  if (options?.length) return sampleFor(options.find((o) => o.type === 'null') ?? options[0]!);
  const type = Array.isArray(schema.type) ? (schema.type.includes('null') ? 'null' : schema.type[0]) : schema.type;
  switch (type) {
    case 'null':
      return null;
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0);
    case 'string':
      return 'x'.repeat(schema.minLength ?? 0);
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () => sampleFor(schema.items ?? {}));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = sampleFor(schema.properties?.[key] ?? {});
      return out;
    }
    default:
      return null;
  }
}
