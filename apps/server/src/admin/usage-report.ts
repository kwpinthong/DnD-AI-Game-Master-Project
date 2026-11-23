import type { AiUsageGameResponse, AiUsageOverviewResponse, UsageCeiling, UsageFailure, UsageTotals } from '@isekai/protocol';
import { PERIODS } from '@isekai/rules';
import { eq, max, sql, sum, count } from 'drizzle-orm';
import type { AiConfig } from '../ai/config.ts';
import { monthStartUtc } from '../ai/core/usage.ts';
import type { Db } from '../db/client.ts';
import { game } from '../db/schema.ts';
import { aiUsage } from '../db/schema-ai.ts';

/**
 * Sums of the ai_usage table for the server owner's dashboard (GEN-061). Reads numbers, purposes,
 * periods and models only: the failure reason is cut to its kind (`timeout`, `refusal`, ...) in SQL,
 * so its detail never leaves the database.
 */

const PERIOD_ORDER: readonly string[] = PERIODS;
/** Warning from this share of the ceiling (C3). */
export const CEILING_WARNING_PERCENT = 80;

interface Group {
  gameId: string;
  purpose: string;
  day: number | null;
  phase: string | null;
  model: string;
  ok: number;
  kind: string | null;
  thisMonth: number;
  calls: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  cost: number;
  lastAt: number | null;
}

function groups(db: Db, monthStart: number, gameId?: string): Group[] {
  const kind = sql<string | null>`case when ${aiUsage.ok} = 0 then substr(${aiUsage.failureReason}, 1, instr(${aiUsage.failureReason} || ':', ':') - 1) end`;
  const thisMonth = sql<number>`(${aiUsage.createdAt} >= ${monthStart})`;
  const query = db
    .select({
      gameId: aiUsage.gameId,
      purpose: aiUsage.purpose,
      day: aiUsage.day,
      phase: aiUsage.phase,
      model: aiUsage.model,
      ok: aiUsage.ok,
      kind,
      thisMonth,
      calls: count(),
      input: sum(aiUsage.inputTokens).mapWith(Number),
      cached: sum(aiUsage.cachedInputTokens).mapWith(Number),
      cacheWrite: sum(aiUsage.cacheWriteTokens).mapWith(Number),
      output: sum(aiUsage.outputTokens).mapWith(Number),
      cost: sum(aiUsage.costUsdMicros).mapWith(Number),
      lastAt: max(aiUsage.createdAt),
    })
    .from(aiUsage)
    .$dynamic();
  const filtered = gameId === undefined ? query : query.where(eq(aiUsage.gameId, gameId));
  return filtered
    .groupBy(aiUsage.gameId, aiUsage.purpose, aiUsage.day, aiUsage.phase, aiUsage.model, aiUsage.ok, kind, thisMonth)
    .all() as Group[];
}

const emptyTotals = (): UsageTotals => ({
  calls: 0,
  okCalls: 0,
  failedCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsdMicros: 0,
  unpricedCalls: 0,
});

function add(totals: UsageTotals, g: Group, priced: boolean) {
  totals.calls += g.calls;
  if (g.ok) totals.okCalls += g.calls;
  else totals.failedCalls += g.calls;
  totals.inputTokens += g.input;
  totals.cachedInputTokens += g.cached;
  totals.cacheWriteTokens += g.cacheWrite;
  totals.outputTokens += g.output;
  // A model with no price: tokens count, the cost stays unknown instead of a silent 0 (C8).
  if (priced) totals.costUsdMicros += g.cost;
  else totals.unpricedCalls += g.calls;
}

/** Folds groups into totals keyed by `keyOf`, keeping the first group of each key as its sample. */
function bucket<K>(list: Group[], keyOf: (g: Group) => K, priced: (g: Group) => boolean) {
  const map = new Map<string, { key: K; totals: UsageTotals }>();
  for (const g of list) {
    const key = keyOf(g);
    const id = JSON.stringify(key);
    let entry = map.get(id);
    if (!entry) map.set(id, (entry = { key, totals: emptyTotals() }));
    add(entry.totals, g, priced(g));
  }
  return [...map.values()];
}

const safeKind = (kind: string | null) => (kind && /^[a-z_]{1,40}$/.test(kind) ? kind : 'other');

function failures(list: Group[]): UsageFailure[] {
  const counts = new Map<string, number>();
  for (const g of list) if (!g.ok) counts.set(safeKind(g.kind), (counts.get(safeKind(g.kind)) ?? 0) + g.calls);
  return [...counts]
    .map(([kind, n]) => ({ kind, count: n }))
    .sort((x, y) => y.count - x.count || x.kind.localeCompare(y.kind));
}

function ceiling(list: Group[], config: AiConfig): UsageCeiling {
  const ceilingUsdMicros = Math.round(config.gameMonthlyUsd * 1_000_000);
  const spentUsdMicros = list.filter((g) => g.thisMonth).reduce((n, g) => n + g.cost, 0);
  const percent = ceilingUsdMicros === 0 ? 100 : Math.floor((spentUsdMicros * 100) / ceilingUsdMicros);
  // Same test as the AI service's stop (spent >= ceiling), so "reached" means the AI GM really stopped.
  const status = spentUsdMicros >= ceilingUsdMicros ? 'reached' : percent >= CEILING_WARNING_PERCENT ? 'warning' : 'ok';
  return { spentUsdMicros, ceilingUsdMicros, percent, status };
}

function byPurpose(list: Group[], priced: (g: Group) => boolean) {
  return bucket(list, (g) => g.purpose, priced)
    .sort((x, y) => y.totals.calls - x.totals.calls || x.key.localeCompare(y.key))
    .map(({ key, totals }) => ({ purpose: key, totals }));
}

export function gameUsageReport(db: Db, config: AiConfig, now: number, gameId: string): AiUsageGameResponse | undefined {
  const row = db.select({ name: game.name }).from(game).where(eq(game.id, gameId)).get();
  const list = groups(db, monthStartUtc(now), gameId);
  if (!row && list.length === 0) return undefined;
  const priced = (g: Group) => g.model in config.prices;

  const period = (day: number | null, phase: string | null) => [day ?? Number.MAX_SAFE_INTEGER, phase === null ? 99 : PERIOD_ORDER.indexOf(phase)];
  const totals = emptyTotals();
  for (const g of list) add(totals, g, priced(g));

  return {
    generatedAt: new Date(now).toISOString(),
    game: { id: gameId, name: row?.name ?? null },
    ceiling: ceiling(list, config),
    totals,
    byPurpose: byPurpose(list, priced),
    byPeriod: bucket(list, (g) => [g.day, g.phase] as const, priced)
      .sort((x, y) => {
        const [xd, xp] = period(...x.key);
        const [yd, yp] = period(...y.key);
        return xd! - yd! || xp! - yp!;
      })
      .map(({ key: [day, phase], totals: t }) => ({ day, phase, totals: t })),
    byModel: bucket(list, (g) => g.model, priced)
      .sort((x, y) => y.totals.calls - x.totals.calls || x.key.localeCompare(y.key))
      .map(({ key, totals: t }) => ({ model: key, priced: key in config.prices, totals: t })),
    failures: failures(list),
  };
}

export function overviewUsageReport(db: Db, config: AiConfig, now: number): AiUsageOverviewResponse {
  const list = groups(db, monthStartUtc(now));
  const priced = (g: Group) => g.model in config.prices;
  const names = new Map(db.select({ id: game.id, name: game.name }).from(game).all().map((g) => [g.id, g.name]));
  const ids = new Set([...names.keys(), ...list.map((g) => g.gameId)]);

  const totals = emptyTotals();
  for (const g of list) add(totals, g, priced(g));

  const games = [...ids].map((id) => {
    const mine = list.filter((g) => g.gameId === id);
    const gameTotals = emptyTotals();
    for (const g of mine) add(gameTotals, g, priced(g));
    const lastAt = mine.reduce<number | null>((m, g) => (g.lastAt !== null && (m === null || g.lastAt > m) ? g.lastAt : m), null);
    return {
      game: { id, name: names.get(id) ?? null },
      totals: gameTotals,
      ceiling: ceiling(mine, config),
      lastCallAt: lastAt === null ? null : new Date(lastAt).toISOString(),
      lastAt,
    };
  });
  games.sort((x, y) => (y.lastAt ?? -1) - (x.lastAt ?? -1) || (x.game.name ?? '').localeCompare(y.game.name ?? ''));

  return {
    generatedAt: new Date(now).toISOString(),
    totals,
    byPurpose: byPurpose(list, priced),
    failures: failures(list),
    games: games.map(({ lastAt: _lastAt, ...rest }) => rest),
  };
}
