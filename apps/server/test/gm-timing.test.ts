import { describe, expect, it } from 'vitest';
import { createStageTimer } from '../src/gm/timing.ts';

describe('GEN-115 stage timer', () => {
  it('adds up sync and async stages and the tokens, with names and numbers only', async () => {
    let t = 0;
    const timer = createStageTimer(() => t);
    timer.time('build', () => (t += 5));
    await timer.time('ai', async () => {
      t += 100;
    });
    timer.time('ai', () => (t += 20));
    timer.addTokens({ inputTokens: 10, cachedInputTokens: 2, cacheWriteTokens: 0, outputTokens: 3 });
    timer.addTokens(undefined);
    expect(timer.line()).toBe('build_ms=5 ai_ms=120 total_ms=125 in=10 cached=2 out=3');
  });

  it('still records a stage whose function throws', () => {
    let t = 0;
    const timer = createStageTimer(() => t);
    expect(() => timer.time('rules', () => { t += 7; throw new Error('x'); })).toThrow('x');
    expect(timer.line()).toContain('rules_ms=7');
  });
});
