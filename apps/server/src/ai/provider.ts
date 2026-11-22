// The AiProvider adapter (ADR "Isekai Chronicles - AI GM" §8, interface from GEN-021 §2).
// No provider SDK is imported here: only src/ai/providers/* may do that (GEN-038 C3).

/** What a call is for (ADR §8). Recorded in AiUsage. */
export type AiPurpose =
  | 'gm_adjudicate'
  | 'gm_repair'
  /** The weather of a period that just opened (GEN-068). */
  | 'gm_weather'
  | 'narrate_place'
  | 'narrate_player'
  /** GEN-116: the NPC lines of a turn, written after the result and narration (own AiUsage rows, same budget). */
  | 'npc_dialogue'
  | 'summarize_day'
  | 'summarize_journal'
  | 'finale'
  | 'character_analyze';

/** The period of the day (GEN-063), as `Phase` in `@isekai/protocol`. */
export type AiPhase = 'EOSORIA' | 'SOLARION' | 'HESPERION' | 'NOCTHERION';

/** One system prompt block, ordered most stable → most volatile (ADR §6.2). */
export interface PromptBlock {
  /** Label for logs and cache placement, e.g. 'rules', 'scenario', 'memory', 'state', 'actions'. */
  id: string;
  text: string;
  /** Providers that can cache put a breakpoint after this block. */
  cache: boolean;
}

export interface AiCallRequest {
  purpose: AiPurpose;
  /** Always from config; core never hard-codes a model. */
  model: string;
  system: PromptBlock[];
  messages: { role: 'user' | 'assistant'; text: string }[];
  /** JSON schema the answer must follow (z.toJSONSchema of the protocol schema). */
  output: { name: string; jsonSchema: Record<string, unknown> };
  maxOutputTokens: number;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AiTokenUsage {
  /** Not counting cached input. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Includes thinking when the provider counts it as output. */
  outputTokens: number;
}

export type AiErrorKind = 'refusal' | 'max_tokens' | 'invalid_json' | 'rate_limited' | 'timeout' | 'provider_error';

export type AiCallResult =
  | { ok: true; json: unknown; usage: AiTokenUsage; model: string; latencyMs: number }
  | {
      ok: false;
      error: AiErrorKind;
      /** Short, key-free description (status, error type). Never prompt text. */
      detail: string;
      usage: AiTokenUsage | null;
      retryable: boolean;
      latencyMs: number;
    };

export type AiReadiness = { ok: true } | { ok: false; reason: string };

export interface AiProvider {
  /** 'mock' | 'anthropic' | ... (the AI_PROVIDER value). */
  readonly id: string;
  /** Whether calls can be made now (e.g. an API key is set); `reason` is Thai for the owner / GM. */
  ready(): AiReadiness;
  call(req: AiCallRequest): Promise<AiCallResult>;
  /** Rough count for trimming context; does not need to be exact. */
  estimateTokens(text: string): number;
}

export const ZERO_USAGE: AiTokenUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
