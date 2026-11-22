import { z } from 'zod';

/**
 * The server owner's AI usage dashboard (GEN-061, Q-058). Only the server owner sees it: the web
 * exchanges the admin code (ADMIN_CODE_HASH on the server) for a short-lived admin token.
 * Every body here is numbers, purposes and game ids/names only: never narration, prompts, character
 * names, karma or actions (the schemas are strict so nothing else can ride along).
 */

/** Body of POST /api/admin/session. */
export const AdminSessionRequest = z.object({ code: z.string().min(1, 'ใส่ admin code') });
export type AdminSessionRequest = z.infer<typeof AdminSessionRequest>;

/** 200 from POST /api/admin/session: send `token` as `Authorization: Bearer <token>` until `expiresAt`. */
export const AdminSessionResponse = z.strictObject({ token: z.string(), expiresAt: z.string() });
export type AdminSessionResponse = z.infer<typeof AdminSessionResponse>;

export const UsageTotals = z.strictObject({
  calls: z.number().int(),
  okCalls: z.number().int(),
  failedCalls: z.number().int(),
  inputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** Estimate from the server's price table, micro-USD, for calls whose model has a price. */
  costUsdMicros: z.number().int(),
  /** Calls whose model has no price in the config: their tokens count, their cost is unknown (not 0). */
  unpricedCalls: z.number().int(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** The kind part of a failure reason (`timeout`, `refusal`, `invalid_json`, `schema_mismatch`, ...); never the detail. */
export const UsageFailure = z.strictObject({ kind: z.string(), count: z.number().int() });
export type UsageFailure = z.infer<typeof UsageFailure>;

/** This calendar month (UTC) against the per-game ceiling AI_GAME_MONTHLY_USD. */
export const UsageCeiling = z.strictObject({
  spentUsdMicros: z.number().int(),
  ceilingUsdMicros: z.number().int(),
  /** spent / ceiling × 100, rounded down; 100 when the ceiling is 0. */
  percent: z.number().int(),
  /** warning from 80 %, reached from 100 % (the AI GM stops calling until next month). */
  status: z.enum(['ok', 'warning', 'reached']),
});
export type UsageCeiling = z.infer<typeof UsageCeiling>;

export const UsageGameRef = z.strictObject({
  id: z.string(),
  /** The game's name; null when the game was deleted (usage rows stay). */
  name: z.string().nullable(),
});
export type UsageGameRef = z.infer<typeof UsageGameRef>;

export const UsageByPurpose = z.strictObject({ purpose: z.string(), totals: UsageTotals });
export const UsageByModel = z.strictObject({ model: z.string(), priced: z.boolean(), totals: UsageTotals });
/** Day 1..12 and period of the call; both null for calls outside the turn loop (loot, origin, ...). */
export const UsageByPeriod = z.strictObject({
  day: z.number().int().nullable(),
  phase: z.string().nullable(),
  totals: UsageTotals,
});

/** 200 from GET /api/admin/ai-usage: every game, newest activity first. */
export const AiUsageOverviewResponse = z.strictObject({
  generatedAt: z.string(),
  totals: UsageTotals,
  byPurpose: z.array(UsageByPurpose),
  failures: z.array(UsageFailure),
  games: z.array(
    z.strictObject({ game: UsageGameRef, totals: UsageTotals, ceiling: UsageCeiling, lastCallAt: z.string().nullable() }),
  ),
});
export type AiUsageOverviewResponse = z.infer<typeof AiUsageOverviewResponse>;

/** 200 from GET /api/admin/ai-usage/:gameId. */
export const AiUsageGameResponse = z.strictObject({
  generatedAt: z.string(),
  game: UsageGameRef,
  ceiling: UsageCeiling,
  totals: UsageTotals,
  byPurpose: z.array(UsageByPurpose),
  byPeriod: z.array(UsageByPeriod),
  byModel: z.array(UsageByModel),
  failures: z.array(UsageFailure),
});
export type AiUsageGameResponse = z.infer<typeof AiUsageGameResponse>;
