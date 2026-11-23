import Anthropic from '@anthropic-ai/sdk';
import type { AiConfig } from '../config.ts';
import type { AiCallRequest, AiCallResult, AiErrorKind, AiProvider, AiTokenUsage } from '../provider.ts';

/**
 * Claude through the official SDK (default provider, Q-018 claude-sonnet-5-5).
 * - The answer's JSON schema goes into the prompt and the answer comes back as JSON text (Q-285). The real API
 *   refused the GM schemas as structured output (`output_config.format`: no `maxItems`, at most 16 union-typed
 *   parameters, "the compiled grammar is too large") and refuses a forced `tool_choice` on Sonnet 5.5. The
 *   AI service checks every answer with the zod schema, so a wrong answer is a `schema_mismatch` it retries.
 * - Thinking left at the model default (Sonnet 5.5 rejects `disabled`); depth via `output_config.effort`.
 * - `stop_reason` checked before content: `refusal` / `max_tokens` are failures the service retries.
 * - Server-side refusal fallback (`fallbacks: "default"`) on models that support it.
 * - SDK retries off: the AI service owns retry, so every attempt is one AiUsage row.
 * - The key comes from ANTHROPIC_API_KEY only, and is scrubbed from every detail string.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_CACHE_BREAKPOINTS = 4;

/** Models that accept `fallbacks: "default"` (Haiku 5.5 has no server-side fallback). */
const supportsFallback = (model: string) => /^claude-(?:sonnet-5-5|opus-5-5|fable-5-[12])$/.test(model);

const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export function createAnthropicProvider(config: AiConfig): AiProvider {
  const { apiKey, baseUrl } = config.anthropic;
  const client = apiKey
    ? new Anthropic({ apiKey, maxRetries: 0, timeout: config.timeoutMs, ...(baseUrl ? { baseURL: baseUrl } : {}) })
    : undefined;
  const scrub = (text: string) => (apiKey ? text.split(apiKey).join('[redacted]') : text);

  return {
    id: 'anthropic',
    estimateTokens,
    ready: () =>
      client
        ? { ok: true }
        : { ok: false, reason: 'ยังไม่ได้ตั้ง ANTHROPIC_API_KEY บน server จึงสร้างหรือเริ่มเกมที่ใช้ AI GM ไม่ได้ (ให้เจ้าของ server ตั้งค่าแล้วเริ่ม server ใหม่)' },
    async call(req) {
      const started = Date.now();
      const latency = () => Date.now() - started;
      if (!client) return failure('provider_error', 'no api key', null, false, latency());

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create(toParams(req), {
          timeout: req.timeoutMs,
          maxRetries: 0,
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (error) {
        const { kind, retryable, detail } = classify(error);
        return failure(kind, scrub(detail), null, retryable, latency());
      }

      const usage = toUsage(response.usage);
      if (response.stop_reason === 'refusal') {
        return failure('refusal', `refusal ${response.stop_details?.category ?? 'uncategorized'}`, usage, true, latency());
      }
      if (response.stop_reason === 'max_tokens') return failure('max_tokens', 'max_tokens', usage, true, latency());

      const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      try {
        return { ok: true, json: parseAnswer(text), usage, model: response.model, latencyMs: latency() };
      } catch {
        return failure('invalid_json', `not JSON (${text.length} chars, stop ${response.stop_reason})`, usage, true, latency());
      }
    },
  };
}

/** The JSON of an answer: the text itself, or the object inside a code fence or a sentence around it. Throws when there is none. */
function parseAnswer(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  }
}

/** The last system block (after the caller's, so their cache breakpoints stand): what the answer must be. */
function answerFormat(output: AiCallRequest['output']): string {
  const { $schema: _drop, ...schema } = output.jsonSchema;
  return [
    `Answer with one JSON object only (${output.name}): no text before or after it, no code fence.`,
    'It must follow this JSON Schema exactly: every required property, no property the schema does not name, null where the schema allows null.',
    'Leave out every property whose value would be its "default" (the server fills it in); write it only when the value differs.',
    JSON.stringify(schema),
  ].join('\n');
}

function toParams(req: AiCallRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
  // GEN-118: the answer format (the schema, the same for every call of one output) is cached too, one breakpoint of the four.
  const cachedIndexes = req.system.flatMap((block, i) => (block.cache ? [i] : [])).slice(-(MAX_CACHE_BREAKPOINTS - 1));
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    system: [
      ...req.system.map((block, i) => ({
        type: 'text' as const,
        text: block.text,
        ...(cachedIndexes.includes(i) ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
      { type: 'text' as const, text: answerFormat(req.output), cache_control: { type: 'ephemeral' as const } },
    ],
    messages: req.messages.map((message) => ({ role: message.role, content: message.text })),
    output_config: { effort: req.effort },
    ...(supportsFallback(req.model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
}

function toUsage(usage: Anthropic.Beta.BetaUsage): AiTokenUsage {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

function failure(error: AiErrorKind, detail: string, usage: AiTokenUsage | null, retryable: boolean, latencyMs: number): AiCallResult {
  return { ok: false, error, detail, usage, retryable, latencyMs };
}

/** Maps SDK errors to the adapter's kinds. Detail is status + API error type, not the message body. */
function classify(error: unknown): { kind: AiErrorKind; retryable: boolean; detail: string } {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'timeout', retryable: true, detail: 'timeout' };
  if (error instanceof Anthropic.APIUserAbortError) return { kind: 'provider_error', retryable: false, detail: 'aborted' };
  if (error instanceof Anthropic.APIConnectionError) return { kind: 'provider_error', retryable: true, detail: 'connection error' };
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const body = error.error as { error?: { type?: unknown } } | undefined;
    const type = typeof body?.error?.type === 'string' ? body.error.type : 'unknown';
    const detail = `http ${status} ${type}`;
    if (error instanceof Anthropic.RateLimitError) return { kind: 'rate_limited', retryable: true, detail };
    return { kind: 'provider_error', retryable: status >= 500 || status === 408 || status === 409, detail };
  }
  return { kind: 'provider_error', retryable: false, detail: error instanceof Error ? error.name : 'unknown error' };
}
