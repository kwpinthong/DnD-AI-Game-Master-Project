import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { z } from 'zod';
import { loadAiConfig, type AiConfig } from '../../src/ai/config.ts';
import { createAiService, type AiService, type BudgetReachedEvent } from '../../src/ai/core/service.ts';
import { createUsageStore, type UsageStore } from '../../src/ai/core/usage.ts';
import type { AiProvider } from '../../src/ai/provider.ts';
import { openDatabase, type OpenedDatabase } from '../../src/db/client.ts';
import { makeTempDir } from '../helpers.ts';

/** 2026-11-15 12:00 UTC: the middle of a month, so "this month" is unambiguous. */
export const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

/** The output a trigger asks for in these tests (stands in for PhaseProposal etc.). */
export const Verdict = z.object({ verdict: z.enum(['ok', 'blocked']), note: z.string() });

/** A real name that must never reach a log (Q-045: prompts carry {{p:id}} tokens, logs carry metadata). */
export const NAME_CANARY = 'ลินดาราผู้ซ่อนชื่อ';

export function trigger(gameId = 'game-1') {
  return {
    gameId,
    purpose: 'gm_adjudicate' as const,
    day: 1,
    phase: 'MORNING' as const,
    system: [{ id: 'rules', text: 'คุณคือ Game Master ผู้ตัดสินอย่างเคร่งครัด', cache: true }],
    messages: [{ role: 'user' as const, text: `{{p:p_a}} (${NAME_CANARY}) ขอเปิดประตู` }],
    output: { name: 'verdict', schema: Verdict },
    maxOutputTokens: 2000,
  };
}

/** Config as the env would give it, with test-friendly retry delay. */
export function aiConfig(env: Record<string, string | undefined>): AiConfig {
  return loadAiConfig({ AI_RETRY_DELAY_MS: '0', ...env });
}

export interface ServiceHarness {
  service: AiService;
  usage: UsageStore;
  opened: OpenedDatabase;
  logs: string[];
  budgetEvents: BudgetReachedEvent[];
  cleanup(): void;
}

export function makeService(provider: AiProvider, config: AiConfig, now = () => NOW): ServiceHarness {
  const temp = makeTempDir();
  const opened = openDatabase(join(temp.dir, 'isekai.sqlite'));
  const usage = createUsageStore(opened.db);
  const logs: string[] = [];
  const budgetEvents: BudgetReachedEvent[] = [];
  const service = createAiService({
    provider,
    config,
    usage,
    now,
    log: (line) => logs.push(line),
    onBudgetReached: (event) => budgetEvents.push(event),
  });
  return {
    service,
    usage,
    opened,
    logs,
    budgetEvents,
    cleanup() {
      opened.sqlite.close();
      temp.cleanup();
    },
  };
}

export type UsageRow = {
  game_id: string;
  day: number | null;
  phase: string | null;
  purpose: string;
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
  ok: number;
  failure_reason: string | null;
  attempt: number;
};

export function usageRows(sqlite: Database.Database): UsageRow[] {
  return sqlite.prepare('select * from ai_usage order by id').all() as UsageRow[];
}
