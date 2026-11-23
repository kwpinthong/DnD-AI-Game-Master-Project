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

/**
 * GEN-147: the game data editor (server owner only). A data set is one JSON array (NPC, NPC_Schedule, Location,
 * Item, Ability, Start_Scenarios, System_Rules, World_Timeline, Day10_Strategies, Server_Lines); the server checks
 * a save with the same schemas as the asset loader. `value` is that array as JSON.
 */
export const GameDataSetSummary = z.strictObject({
  name: z.string(),
  /** The asset file it was seeded from and an export writes it to. */
  file: z.string(),
  records: z.number().int(),
  updatedAt: z.string(),
  /** There is an edit an undo can take back. */
  canUndo: z.boolean(),
  /** GEN-179: the saved value fails the schema (after a deploy), so the server uses the asset file until a valid save. */
  fallback: z.strictObject({ message: z.string(), fields: z.record(z.string(), z.string()) }).optional(),
});
export type GameDataSetSummary = z.infer<typeof GameDataSetSummary>;

/** 200 from GET /api/admin/game-data. */
export const GameDataListResponse = z.strictObject({ sets: z.array(GameDataSetSummary) });
export type GameDataListResponse = z.infer<typeof GameDataListResponse>;

/** 200 from GET / PUT /api/admin/game-data/:name and POST /api/admin/game-data/:name/undo. */
export const GameDataSetResponse = z.strictObject({ set: GameDataSetSummary, value: z.unknown() });
export type GameDataSetResponse = z.infer<typeof GameDataSetResponse>;

/** Body of PUT /api/admin/game-data/:name: the whole data set. A schema miss = 400 invalid_input with `fields`. */
export const GameDataSaveRequest = z.object({ value: z.unknown() });
export type GameDataSaveRequest = z.infer<typeof GameDataSaveRequest>;

export const GameDataAuditEntry = z.strictObject({
  id: z.number().int(),
  name: z.string(),
  action: z.enum(['edit', 'undo']),
  at: z.string(),
  /** File in the data folder's backups/game-data holding the value before this change. */
  backupFile: z.string(),
  /** Records that differ, by position; `null` = no record there on that side. */
  changes: z.array(z.strictObject({ index: z.number().int(), old: z.unknown(), new: z.unknown() })),
});
export type GameDataAuditEntry = z.infer<typeof GameDataAuditEntry>;

/**
 * GEN-173: 200 from GET /api/admin/game-data/:name/asset-file — the set's asset file now (after `pnpm assets:import`),
 * already checked by the schemas, and its diff against the DB. Nothing is saved; the admin confirms with the PUT.
 */
export const GameDataImportPreviewResponse = z.strictObject({ set: GameDataSetSummary, value: z.unknown(), changes: GameDataAuditEntry.shape.changes });
export type GameDataImportPreviewResponse = z.infer<typeof GameDataImportPreviewResponse>;

/** 200 from GET /api/admin/game-data-audit: newest first. */
export const GameDataAuditResponse = z.strictObject({ entries: z.array(GameDataAuditEntry) });
export type GameDataAuditResponse = z.infer<typeof GameDataAuditResponse>;

/** 200 from GET /api/admin/game-data-export: file name → JSON, the asset loader reads a folder of these. */
export const GameDataExportResponse = z.strictObject({ exportedAt: z.string(), files: z.record(z.string(), z.unknown()) });
export type GameDataExportResponse = z.infer<typeof GameDataExportResponse>;

/**
 * GEN-199: an AI answer the server refused (before its repair), tokens for every name, each text cut short.
 * `got`: the AI's value at `path` as JSON (cut short); `message` names the expected value.
 */
export const GmRefusal = z.strictObject({
  at: z.string(),
  purpose: z.string(),
  stage: z.enum(['first', 'repair']),
  errors: z.array(z.strictObject({ code: z.string(), path: z.string(), message: z.string(), got: z.string() })),
  /** The scrubbed answer as JSON, cut to a size limit (may then not parse). */
  proposal: z.string(),
});
export type GmRefusal = z.infer<typeof GmRefusal>;

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
  /** GEN-199: the newest refused answers of this game, newest first. */
  refusals: z.array(GmRefusal),
});
export type AiUsageGameResponse = z.infer<typeof AiUsageGameResponse>;
