import type { AiConfig } from '../config.ts';
import type { AiCallRequest, AiCallResult, AiErrorKind, AiProvider, AiTokenUsage } from '../provider.ts';

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

export function createMockProvider(_config: AiConfig, script?: MockScript): MockProvider {
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
          req.purpose === 'character_analyze'
            ? cannedLoot(requests.length)
            : req.purpose === 'gm_weather'
              ? cannedWeather(requests.filter((r) => r.purpose === 'gm_weather').length)
              : sampleFor(req.output.jsonSchema);
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
 * A fixed loot answer for offline dev (GEN-048): the smallest schema sample has no options, so the
 * loot step would always fail. Call n picks 3 skills / 3 items from rotating pools, so a reroll
 * shows a different set.
 */
const CANNED_SKILLS = [
  { name: 'อ่านสีหน้า', description: 'รู้ว่าคู่สนทนาโกหกเมื่อสังเกตนาน ๆ', tier: 'Common', buffType: 'Qualitative', effect: null },
  { name: 'สายตาเหยี่ยว', description: 'เห็นของที่ซ่อนอยู่ได้ไวกว่าคนทั่วไป', tier: 'Common', buffType: 'Quantitative', effect: { type: 'check_bonus', scope: 'perception', value: 2 } },
  { name: 'ก้าวเงียบ', description: 'เดินไม่มีเสียงบนพื้นไม้', tier: 'Common', buffType: 'Quantitative', effect: { type: 'check_bonus', scope: 'stealth', value: 1 } },
  { name: 'ต่อรองเก่ง', description: 'พ่อค้ามักยอมลดราคาให้', tier: 'Common', buffType: 'Qualitative', effect: null },
  { name: 'ถึกทน', description: 'ทนแรงกระแทกได้ดีกว่าคนอื่น', tier: 'Common', buffType: 'Quantitative', effect: { type: 'damage_reduction', value: 1 } },
];
const CANNED_ITEMS = [
  { name: 'เสื้อหนังเก่า', description: 'กันมีดได้บ้าง', tier: 'Common', buffType: 'Quantitative', effect: { type: 'damage_reduction', value: 2 } },
  { name: 'สมุดจดลับ', description: 'จดเรื่องที่ได้ยินไว้อ่านทีหลัง', tier: 'Common', buffType: 'Qualitative', effect: null },
  { name: 'ยาบำรุงกำลัง', description: 'จิบแล้วเหนื่อยน้อยลง', tier: 'Common', buffType: 'Quantitative', effect: { type: 'stamina_refund', value: 1 } },
  { name: 'ตะเกียงพกพา', description: 'ส่องทางในที่มืด', tier: 'Common', buffType: 'Quantitative', effect: { type: 'check_bonus', scope: 'perception', value: 1 } },
  { name: 'จี้เงินของแม่', description: 'ของที่ระลึกจากบ้านเกิด', tier: 'Common', buffType: 'Qualitative', effect: null },
];

/** Weather for offline dev (GEN-068): call n rotates through weathers every period allows, so periods differ. */
const CANNED_WEATHER = ['Rain', 'Fog', 'Clear', 'Storm'] as const;
const cannedWeather = (n: number) => ({ weather: CANNED_WEATHER[(n - 1) % CANNED_WEATHER.length] });

function cannedLoot(n: number) {
  const pick = <T>(pool: T[]) => [0, 1, 2].map((i) => pool[(n - 1 + i) % pool.length]!);
  return {
    strength: { label: 'ช่างสังเกต', scope: 'observe', description: 'บุคลิกบอกว่าคอยมองรายละเอียดรอบตัว' },
    weakness: { label: 'ลังเล', scope: 'priority', description: 'คิดนานก่อนลงมือ' },
    skills: pick(CANNED_SKILLS),
    items: pick(CANNED_ITEMS),
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
