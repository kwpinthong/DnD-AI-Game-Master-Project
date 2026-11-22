import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { aiUsage } from '../../db/schema-ai.ts';
import type { ModelPrice } from '../config.ts';
import type { AiPhase, AiPurpose, AiTokenUsage } from '../provider.ts';

export interface UsageRecord {
  gameId: string;
  day: number | null;
  phase: AiPhase | null;
  turn: number | null;
  purpose: AiPurpose;
  provider: string;
  model: string;
  tokens: AiTokenUsage;
  costUsdMicros: number;
  ok: boolean;
  failureReason: string | null;
  attempt: number;
  latencyMs: number;
  createdAt: number;
}

export interface UsageStore {
  record(row: UsageRecord): void;
  /** Micro-USD spent by the game since the start of `now`'s calendar month (UTC). */
  spentThisMonth(gameId: string, now: number): number;
}

export function createUsageStore(db: Db): UsageStore {
  return {
    record(row) {
      db.insert(aiUsage)
        .values({
          gameId: row.gameId,
          day: row.day,
          phase: row.phase,
          turn: row.turn,
          purpose: row.purpose,
          provider: row.provider,
          model: row.model,
          inputTokens: row.tokens.inputTokens,
          cachedInputTokens: row.tokens.cachedInputTokens,
          cacheWriteTokens: row.tokens.cacheWriteTokens,
          outputTokens: row.tokens.outputTokens,
          costUsdMicros: row.costUsdMicros,
          ok: row.ok ? 1 : 0,
          failureReason: row.failureReason,
          attempt: row.attempt,
          latencyMs: row.latencyMs,
          createdAt: row.createdAt,
        })
        .run();
    },
    spentThisMonth(gameId, now) {
      const result = db
        .select({ total: sql<number>`coalesce(sum(${aiUsage.costUsdMicros}), 0)` })
        .from(aiUsage)
        .where(and(eq(aiUsage.gameId, gameId), gte(aiUsage.createdAt, monthStartUtc(now))))
        .get();
      return result?.total ?? 0;
    },
  };
}

export function monthStartUtc(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Prices are USD per 1M tokens, i.e. micro-USD per token. */
export function costUsdMicros(tokens: AiTokenUsage, price: ModelPrice): number {
  return Math.round(
    tokens.inputTokens * price.inputPerM +
      tokens.cachedInputTokens * price.cachedInputPerM +
      tokens.cacheWriteTokens * price.cacheWritePerM +
      tokens.outputTokens * price.outputPerM,
  );
}
