import { afterEach, describe, expect, it } from 'vitest';
import { createMockProvider, mockReply } from '../../src/ai/providers/mock.ts';
import { aiConfig, makeService, NOW, trigger, type ServiceHarness } from './fixtures.ts';

const GOOD = { verdict: 'ok', note: 'เปิดได้' };
const usd = (amount: number) => Math.round(amount * 1_000_000);

function spend(harness: ServiceHarness, gameId: string, costUsd: number, at: number) {
  harness.usage.record({
    gameId,
    day: null,
    phase: null,
    turn: null,
    purpose: 'gm_adjudicate',
    provider: 'mock',
    model: 'claude-sonnet-5-5',
    tokens: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    costUsdMicros: usd(costUsd),
    ok: true,
    failureReason: null,
    attempt: 1,
    latencyMs: 0,
    createdAt: at,
  });
}

// GEN-038 C6: Given the game reached its ceiling / When a new trigger comes / Then no call reaches
// the provider and the owner / GM is told.
describe('C6 ceiling per game per month (Q-018: 20 USD)', () => {
  let harness: ServiceHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it('blocks the call, tells the owner / GM once, and leaves other games alone', async () => {
    const config = aiConfig({ AI_PROVIDER: 'mock' });
    const mock = createMockProvider(config, { steps: [mockReply.ok(GOOD)] });
    harness = makeService(mock, config);
    spend(harness, 'game-full', 19.5, NOW - 60_000);
    spend(harness, 'game-full', 0.5, NOW - 30_000);

    const first = await harness.service.call(trigger('game-full'));
    const second = await harness.service.call(trigger('game-full'));

    for (const result of [first, second]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('budget_reached');
        expect(result.error.audience).toBe('owner_gm');
        expect(result.error.message).toMatch(/เพดาน/);
        expect(result.error.message).toMatch(/20/);
      }
    }
    expect(mock.requests).toHaveLength(0);
    expect(harness.budgetEvents).toEqual([
      expect.objectContaining({ gameId: 'game-full', spentUsdMicros: usd(20), ceilingUsdMicros: usd(20) }),
    ]);

    const other = await harness.service.call(trigger('game-other'));
    expect(other.ok).toBe(true);
    expect(mock.requests).toHaveLength(1);
  });

  it('counts only this calendar month (UTC): last month spending does not block', async () => {
    const config = aiConfig({ AI_PROVIDER: 'mock' });
    const mock = createMockProvider(config, { steps: [mockReply.ok(GOOD)] });
    harness = makeService(mock, config);
    spend(harness, 'game-1', 25, Date.UTC(2026, 9, 31, 23, 59));

    const result = await harness.service.call(trigger('game-1'));
    expect(result.ok).toBe(true);
    expect(harness.usage.spentThisMonth('game-1', NOW)).toBeGreaterThan(0);
    expect(harness.usage.spentThisMonth('game-1', NOW)).toBeLessThan(usd(1));
  });

  it('the ceiling is configurable with AI_GAME_MONTHLY_USD and also stops retries that would cross it', async () => {
    const config = aiConfig({ AI_PROVIDER: 'mock', AI_GAME_MONTHLY_USD: '1', AI_MAX_RETRIES: '2' });
    const mock = createMockProvider(config, {
      steps: [mockReply.fail('invalid_json', { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100_000 })],
    });
    harness = makeService(mock, config);

    // The first attempt costs 100k output tokens × 10 USD/M = 1 USD: the retry must not be sent.
    const result = await harness.service.call(trigger('game-small'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('budget_reached');
    expect(mock.requests).toHaveLength(1);
    expect(harness.budgetEvents).toHaveLength(1);
  });
});
