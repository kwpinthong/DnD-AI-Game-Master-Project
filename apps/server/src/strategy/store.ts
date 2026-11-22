import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.ts';
import { strategyOutcome, strategyParticipant } from '../db/schema.ts';

/**
 * The Day10_Strategies plans of a game (GEN-093, Q-203): who took part in which plan on the night of day 10
 * (the AI GM's `strategy` of each action, with the action's result), and how each plan ended once the night is
 * over. The day 12 finale reads both (`strategyRefuges`). Server-only until the game ends.
 */

export type StrategyRole = 'leader' | 'support';
/** World_Drift_If_Ignored of the night: nobody ran a plan, or every plan failed. Never a plan anyone runs. */
export const DRIFT_STRATEGY_ID = 'D10-DRIFT';

export interface StrategyParticipation {
  memberId: string;
  strategyId: string;
  role: StrategyRole;
  success: boolean;
  day: number;
}

export interface StrategyOutcomeRecord {
  strategyId: string;
  outcome: 'success' | 'failed' | 'drift';
}

/** One player's action in a plan. A leader turn replaces a support turn; the same role again replaces the earlier turn. */
export function recordStrategyParticipation(db: DbOrTx, gameId: string, entry: StrategyParticipation, now: number): void {
  const existing = db
    .select({ role: strategyParticipant.role })
    .from(strategyParticipant)
    .where(and(eq(strategyParticipant.gameId, gameId), eq(strategyParticipant.memberId, entry.memberId), eq(strategyParticipant.strategyId, entry.strategyId)))
    .get();
  if (existing?.role === 'leader' && entry.role === 'support') return;
  const values = { role: entry.role, success: entry.success, day: entry.day, updatedAt: now };
  db.insert(strategyParticipant)
    .values({ gameId, memberId: entry.memberId, strategyId: entry.strategyId, ...values })
    .onConflictDoUpdate({ target: [strategyParticipant.gameId, strategyParticipant.memberId, strategyParticipant.strategyId], set: values })
    .run();
}

export function strategyParticipants(db: DbOrTx, gameId: string): StrategyParticipation[] {
  return db
    .select({
      memberId: strategyParticipant.memberId,
      strategyId: strategyParticipant.strategyId,
      role: strategyParticipant.role,
      success: strategyParticipant.success,
      day: strategyParticipant.day,
    })
    .from(strategyParticipant)
    .where(eq(strategyParticipant.gameId, gameId))
    .all();
}

/** How each plan ended, by strategy id; empty until the night of day 10 is over. */
export function strategyOutcomes(db: DbOrTx, gameId: string): StrategyOutcomeRecord[] {
  return db
    .select({ strategyId: strategyOutcome.strategyId, outcome: strategyOutcome.outcome })
    .from(strategyOutcome)
    .where(eq(strategyOutcome.gameId, gameId))
    .all()
    .sort((a, b) => a.strategyId.localeCompare(b.strategyId));
}

/**
 * Called when the strategy event resolves (the night of day 10 is over): a plan with participants succeeded
 * when one of its leaders succeeded, else it failed; no plan succeeded = `D10-DRIFT` for the game. Written
 * once: a second call keeps the first result.
 */
export function settleStrategies(db: DbOrTx, gameId: string, now: number): void {
  const exists = db.select({ id: strategyOutcome.strategyId }).from(strategyOutcome).where(eq(strategyOutcome.gameId, gameId)).get();
  if (exists) return;
  const byPlan = new Map<string, boolean>();
  for (const p of strategyParticipants(db, gameId)) {
    byPlan.set(p.strategyId, (byPlan.get(p.strategyId) ?? false) || (p.role === 'leader' && p.success));
  }
  const rows: { strategyId: string; outcome: StrategyOutcomeRecord['outcome'] }[] = [...byPlan].map(([strategyId, ok]) => ({
    strategyId,
    outcome: ok ? 'success' : 'failed',
  }));
  if (!rows.some((r) => r.outcome === 'success')) rows.push({ strategyId: DRIFT_STRATEGY_ID, outcome: 'drift' });
  db.insert(strategyOutcome)
    .values(rows.map((r) => ({ gameId, ...r, createdAt: now })))
    .run();
}
