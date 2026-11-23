import type { AiErrorKind, AiPurpose } from './provider.ts';

/** Provider ids AI_PROVIDER accepts. registry.ts must have a factory for each (checked by its type). */
export const AI_PROVIDERS = ['anthropic', 'mock'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** USD per 1M tokens, which is also micro-USD per token. */
export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM: number;
  cacheWritePerM: number;
  outputPerM: number;
}

/**
 * Prices used for the AiUsage cost estimate (claude-api skill table, cached 2026-11-03).
 * Cache write assumed 1.25 × input (5-minute TTL). Estimates only; change here without touching code.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': { inputPerM: 2, cachedInputPerM: 0.1, cacheWritePerM: 2.5, outputPerM: 10 },
  'claude-haiku-5-5': { inputPerM: 0.1, cachedInputPerM: 0.01, cacheWritePerM: 0.125, outputPerM: 0.5 },
  'claude-opus-5-5': { inputPerM: 4, cachedInputPerM: 0.2, cacheWritePerM: 5, outputPerM: 20 },
  'claude-sonnet-5': { inputPerM: 2, cachedInputPerM: 0.2, cacheWritePerM: 2.5, outputPerM: 10 },
};

export interface AiConfig {
  provider: AiProviderId;
  /** Adjudicate / narrate model (Q-018). */
  model: string;
  /** Memory summaries (ADR §8). */
  summaryModel: string;
  /** Per attempt. */
  timeoutMs: number;
  /** Extra attempts after a failed one (timeout, refusal, bad JSON, rate limit, 5xx). */
  maxRetries: number;
  /** Wait before retry n is n × this. */
  retryDelayMs: number;
  /** Ceiling per game per calendar month (UTC), Q-018. */
  gameMonthlyUsd: number;
  prices: Record<string, ModelPrice>;
  /** Only read by providers/anthropic.ts. Never logged, never sent to a client. */
  anthropic: { apiKey?: string; baseUrl?: string };
  /** Only read by the offline Mock (dev / localhost): purposes it fails with that error (AI_MOCK_FAIL, Q-177). */
  mockFail: Partial<Record<AiPurpose, AiErrorKind>>;
  /** GEN-169: the time a style rewrite may take before the original text goes out (AI_STYLE_REWRITE_MS). */
  styleRewriteMs: number;
}

const PURPOSES = [
  'gm_adjudicate',
  'gm_repair',
  'gm_weather',
  'narrate_place',
  'narrate_player',
  'npc_dialogue',
  'summarize_day',
  'summarize_journal',
  'finale',
  'character_analyze',
  'style_review',
  'npc_chat',
] as const satisfies readonly AiPurpose[];
const ERROR_KINDS = ['refusal', 'max_tokens', 'invalid_json', 'rate_limited', 'timeout', 'provider_error'] as const satisfies readonly AiErrorKind[];

/** "narrate_player:timeout, narrate_place:timeout" → { narrate_player: 'timeout', ... }. */
function parseMockFail(raw: string | undefined): Partial<Record<AiPurpose, AiErrorKind>> {
  const out: Partial<Record<AiPurpose, AiErrorKind>> = {};
  for (const part of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [purpose, kind] = part.split(':').map((s) => s.trim());
    if (!(PURPOSES as readonly string[]).includes(purpose ?? '') || !(ERROR_KINDS as readonly string[]).includes(kind ?? '')) {
      throw new Error(`AI_MOCK_FAIL must be a list of <purpose>:<error> (purposes ${PURPOSES.join(', ')}; errors ${ERROR_KINDS.join(', ')}), got "${part}"`);
    }
    out[purpose as AiPurpose] = kind as AiErrorKind;
  }
  return out;
}

/**
 * Reads AI_PROVIDER (default anthropic), AI_MODEL (claude-sonnet-5-5), AI_SUMMARY_MODEL
 * (claude-haiku-5-5), AI_TIMEOUT_MS (60000), AI_MAX_RETRIES (2), AI_RETRY_DELAY_MS (1000),
 * AI_GAME_MONTHLY_USD (20), AI_STYLE_REWRITE_MS (8000), ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL.
 * A missing key is not an error here: the server starts and the AI service reports why it is not
 * ready (GEN-038 C4). A wrong value is an error naming the variable.
 */
export function loadAiConfig(env: Record<string, string | undefined>): AiConfig {
  const value = (name: string) => env[name]?.trim() || undefined;

  const provider = value('AI_PROVIDER') ?? 'anthropic';
  if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(', ')}, got "${provider}"`);
  }

  const number = (name: string, fallback: number, min: number, integer: boolean) => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
      throw new Error(`${name} must be a ${integer ? 'whole ' : ''}number of at least ${min}, got "${raw}"`);
    }
    return parsed;
  };

  const apiKey = value('ANTHROPIC_API_KEY');
  const baseUrl = value('ANTHROPIC_BASE_URL');
  return {
    provider: provider as AiProviderId,
    model: value('AI_MODEL') ?? 'claude-sonnet-5-5',
    summaryModel: value('AI_SUMMARY_MODEL') ?? 'claude-haiku-5-5',
    timeoutMs: number('AI_TIMEOUT_MS', 60_000, 1, true),
    maxRetries: number('AI_MAX_RETRIES', 2, 0, true),
    retryDelayMs: number('AI_RETRY_DELAY_MS', 1_000, 0, true),
    gameMonthlyUsd: number('AI_GAME_MONTHLY_USD', 20, 0, false),
    prices: DEFAULT_PRICES,
    anthropic: { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) },
    mockFail: parseMockFail(value('AI_MOCK_FAIL')),
    styleRewriteMs: number('AI_STYLE_REWRITE_MS', 8_000, 1, true),
  };
}
