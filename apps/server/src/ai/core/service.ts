import { z } from 'zod';
import type { AiConfig, ModelPrice } from '../config.ts';
import {
  ZERO_USAGE,
  type AiCallRequest,
  type AiCallResult,
  type AiPhase,
  type AiProvider,
  type AiPurpose,
  type AiTokenUsage,
  type PromptBlock,
} from '../provider.ts';
import { costUsdMicros, monthStartUtc, type UsageStore } from './usage.ts';

/**
 * The AI service boundary the game calls (GEN-038). It knows only the AiProvider interface, so a
 * new provider changes nothing here (C2). Hook points for later tasks:
 * - GEN-025 (create / start game): call `ready()` first and refuse with its `message` when not ok (C4).
 * - GEN-057 (phase loop): every AI request goes through `call()`; a failed result carries the text to show.
 * - GEN-056 (rooms): pass `onBudgetReached` to deliver the ceiling notice to the owner / GM (C6), and
 *   show `error.message` of `audience: 'room'` errors in the room (C5).
 */

/** What the room shows when the AI GM gave no usable answer after the retries (C5). */
export const AI_GM_UNAVAILABLE = 'AI GM ไม่ตอบ ลองอีกครั้ง';

export type AiServiceErrorCode = 'ai_not_ready' | 'ai_unavailable' | 'budget_reached';

/** A failed AI request, with a Thai message ready for its audience. Serialises without `detail`. */
export class AiServiceError extends Error {
  readonly code: AiServiceErrorCode;
  /** `room`: everyone in the game sees it. `owner_gm`: only the game owner / Human GM. */
  readonly audience: 'room' | 'owner_gm';
  /** Server-side diagnostics (last failure reason); never prompt text, never a key. */
  readonly detail: string | undefined;

  constructor(code: AiServiceErrorCode, message: string, audience: 'room' | 'owner_gm', detail?: string) {
    super(message);
    this.name = 'AiServiceError';
    this.code = code;
    this.audience = audience;
    this.detail = detail;
  }

  toJSON() {
    return { code: this.code, message: this.message, audience: this.audience };
  }
}

export interface AiTrigger<T> {
  gameId: string;
  purpose: AiPurpose;
  day?: number;
  phase?: AiPhase;
  /** 1 | 2 within the period, when the call belongs to a turn. */
  turn?: number;
  /** Prompt text uses {{p:id}} / {{n:id}} tokens, never real names (Q-045). It is never logged. */
  system: PromptBlock[];
  messages: AiCallRequest['messages'];
  /** The answer must parse with this schema; otherwise it counts as bad JSON and is retried. */
  output: { name: string; schema: z.ZodType<T> };
  maxOutputTokens: number;
  /** Default: medium for gm_adjudicate / gm_repair, low otherwise (ADR §8). */
  effort?: AiCallRequest['effort'];
  /** Extra attempts for this call; default AI_MAX_RETRIES. Narration uses 1 (Q-177: retry once, then the template). */
  maxRetries?: number;
  signal?: AbortSignal;
  /** GEN-128: refuse (`budget_reached`, detail `reserve`, no ceiling notice) unless this much stays under the ceiling after the spend so far. */
  reserveUsdMicros?: number;
}

/** `usage` (GEN-115): the tokens of the successful attempt; optional so a test double need not give it. */
export type AiServiceResult<T> = { ok: true; value: T; attempts: number; usage?: AiTokenUsage } |{ ok: false; error: AiServiceError };

export type AiReadyState =
  | { ok: true; provider: string; model: string }
  | { ok: false; code: 'ai_not_ready'; message: string };

export interface BudgetReachedEvent {
  gameId: string;
  spentUsdMicros: number;
  ceilingUsdMicros: number;
  /** Thai text for the owner / GM. */
  message: string;
  at: number;
}

export interface AiService {
  ready(): AiReadyState;
  call<T>(trigger: AiTrigger<T>): Promise<AiServiceResult<T>>;
  /**
   * Q-221: the ceiling notice for the owner / Human GM while this game's spend this month (stored AI usage) is
   * at or over the ceiling; null otherwise. Derived on every read, so it survives a restart and clears when the
   * ceiling is raised or the month turns.
   */
  budgetNotice(gameId: string): string | null;
}

export interface AiServiceDeps {
  provider: AiProvider;
  config: AiConfig;
  usage: UsageStore;
  now?: () => number;
  /** One metadata line per attempt. Default: console.log. */
  log?: (line: string) => void;
  /** Called once per game per month when the ceiling stops a call. Default: a log line. */
  onBudgetReached?: (event: BudgetReachedEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** The purposes on the small model (AI_SUMMARY_MODEL); GEN-149 (Q-309): the NPC chat too. */
const SUMMARY_PURPOSES: ReadonlySet<AiPurpose> = new Set(['summarize_day', 'summarize_journal', 'learning_extract', 'npc_chat']);
const NO_PRICE: ModelPrice = { inputPerM: 0, cachedInputPerM: 0, cacheWritePerM: 0, outputPerM: 0 };

/** Second line of defence: anything shaped like an API key never reaches a log or a row. */
const scrubKeys = (text: string) => text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');

export function createAiService(deps: AiServiceDeps): AiService {
  const { provider, config, usage } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ceilingUsdMicros = Math.round(config.gameMonthlyUsd * 1_000_000);
  const notified = new Set<string>();
  const onBudgetReached =
    deps.onBudgetReached ??
    ((event: BudgetReachedEvent) => log(`[ai] game=${event.gameId} ceiling reached (${usdText(event.spentUsdMicros)} USD this month)`));

  const ready = (): AiReadyState => {
    const state = provider.ready();
    return state.ok
      ? { ok: true, provider: provider.id, model: config.model }
      : { ok: false, code: 'ai_not_ready', message: state.reason };
  };

  return {
    ready,
    budgetNotice(gameId) {
      return usage.spentThisMonth(gameId, now()) >= ceilingUsdMicros ? `${budgetMessage()} ระหว่างนี้บรรยายของ AI GM จะเป็นบรรยายสำรองจากระบบ` : null;
    },
    async call<T>(trigger: AiTrigger<T>): Promise<AiServiceResult<T>> {
      const readiness = ready();
      if (!readiness.ok) return { ok: false, error: new AiServiceError('ai_not_ready', readiness.message, 'owner_gm') };

      const model = SUMMARY_PURPOSES.has(trigger.purpose) ? config.summaryModel : config.model;
      const request: AiCallRequest = {
        purpose: trigger.purpose,
        model,
        system: trigger.system,
        messages: trigger.messages,
        // GEN-158: the input side, so a field with a zod default is optional for the AI; parsing fills it in.
        output: { name: trigger.output.name, jsonSchema: z.toJSONSchema(trigger.output.schema, { io: 'input' }) as Record<string, unknown> },
        maxOutputTokens: trigger.maxOutputTokens,
        effort: trigger.effort ?? (trigger.purpose === 'gm_adjudicate' || trigger.purpose === 'gm_repair' ? 'medium' : 'low'),
        // ISK-028 (Q-596 A): Haiku 5.5's default thinking ran day 5's summary to max_tokens at 3,000; off it wrote 566-853.
        ...(trigger.purpose === 'summarize_day' ? { thinking: 'off' as const } : {}),
        timeoutMs: config.timeoutMs,
        ...(trigger.signal ? { signal: trigger.signal } : {}),
      };
      const attempts = 1 + (trigger.maxRetries ?? config.maxRetries);
      let lastFailure = '';

      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1 && config.retryDelayMs > 0) await sleep(config.retryDelayMs * (attempt - 1));
        // Shutdown (GEN-057): no new attempt once the caller gave up.
        if (trigger.signal?.aborted) {
          lastFailure = 'aborted';
          break;
        }

        const at = now();
        const spent = usage.spentThisMonth(trigger.gameId, at);
        if (spent >= ceilingUsdMicros) return { ok: false, error: budgetReached(trigger.gameId, spent, at) };
        if (spent + (trigger.reserveUsdMicros ?? 0) >= ceilingUsdMicros) return { ok: false, error: new AiServiceError('budget_reached', budgetMessage(), 'owner_gm', 'reserve') };

        let result: AiCallResult;
        try {
          result = await provider.call(request);
        } catch (error) {
          const name = error instanceof Error ? error.name : 'unknown';
          result = { ok: false, error: 'provider_error', detail: `threw ${name}`, usage: null, retryable: false, latencyMs: now() - at };
        }

        const tokens = result.usage ?? ZERO_USAGE;
        const answeredBy = result.ok ? result.model : model;
        const price = config.prices[answeredBy] ?? config.prices[model] ?? NO_PRICE;
        let failure: string | null = null;
        let value: T | undefined;
        if (result.ok) {
          const parsed = trigger.output.schema.safeParse(result.json);
          if (parsed.success) value = parsed.data;
          else failure = `schema_mismatch: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))].join(', ')}`;
        } else {
          failure = scrubKeys(`${result.error}: ${result.detail}`);
        }

        const cost = costUsdMicros(tokens, price);
        usage.record({
          gameId: trigger.gameId,
          day: trigger.day ?? null,
          phase: trigger.phase ?? null,
          turn: trigger.turn ?? null,
          purpose: trigger.purpose,
          provider: provider.id,
          model: answeredBy,
          tokens,
          costUsdMicros: cost,
          ok: failure === null,
          failureReason: failure,
          attempt,
          latencyMs: result.latencyMs,
          createdAt: at,
        });
        log(
          scrubKeys(
            `[ai] game=${trigger.gameId} purpose=${trigger.purpose} day=${trigger.day ?? '-'} phase=${trigger.phase ?? '-'} turn=${trigger.turn ?? '-'} ` +
              `provider=${provider.id} model=${answeredBy} attempt=${attempt}/${attempts} ok=${failure === null ? 1 : 0}` +
              (failure ? ` reason="${failure}"` : '') +
              ` in=${tokens.inputTokens} cached=${tokens.cachedInputTokens} cache_write=${tokens.cacheWriteTokens}` +
              ` out=${tokens.outputTokens} cost_usd=${usdText(cost)} latency_ms=${result.latencyMs}`,
          ),
        );

        if (failure === null) return { ok: true, value: value as T, attempts: attempt, usage: tokens };
        lastFailure = failure;
        if (!result.ok && !result.retryable) break;
      }

      return { ok: false, error: new AiServiceError('ai_unavailable', AI_GM_UNAVAILABLE, 'room', lastFailure) };
    },
  };

  function budgetMessage(): string {
    return (
      `AI GM ของเกมนี้ใช้ครบเพดาน ${usdText(ceilingUsdMicros)} USD ของเดือนนี้แล้ว ` +
      'จึงหยุดเรียก AI จนถึงเดือนหน้า หรือจนกว่าเจ้าของ server จะปรับเพดาน (AI_GAME_MONTHLY_USD)'
    );
  }

  function budgetReached(gameId: string, spent: number, at: number): AiServiceError {
    const message = budgetMessage();
    const key = `${gameId}:${monthStartUtc(at)}`;
    if (!notified.has(key)) {
      notified.add(key);
      onBudgetReached({ gameId, spentUsdMicros: spent, ceilingUsdMicros, message, at });
    }
    return new AiServiceError('budget_reached', message, 'owner_gm');
  }
}

function usdText(micros: number): string {
  return (micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 4);
}
