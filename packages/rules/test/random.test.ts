import { describe, expect, it } from 'vitest';
import { RollError, SeededRng, pickWeighted, rollDice, rollRange, type WeightedEntry } from '../src/index.ts';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RollError);
    return (error as RollError).code;
  }
  return undefined;
}

// C2
describe.each([20, 100])('d%i over 10,000 rolls', (sides) => {
  it('hits every face and nothing outside 1..sides', () => {
    const rng = new SeededRng(2031);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const [face] = rollDice(`d${sides}`, rng).faces;
      seen.add(face!);
    }
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(sides);
    expect(seen.size).toBe(sides);
  });
});

describe('rollRange', () => {
  // C3
  it('over 10,000 rolls of 15..25 hits both ends and nothing outside', () => {
    const rng = new SeededRng(1525);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) seen.add(rollRange(15, 25, rng));
    expect([...seen].sort((a, b) => a - b)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  });

  it('returns the only value of a one-value range', () => {
    expect(rollRange(7, 7, new SeededRng(1))).toBe(7);
  });

  it('rejects an empty or fractional range', () => {
    const rng = new SeededRng(1);
    expect(codeOf(() => rollRange(25, 15, rng))).toBe('range');
    expect(codeOf(() => rollRange(1.5, 3, rng))).toBe('range');
    expect(codeOf(() => rollRange(1, Number.NaN, rng))).toBe('range');
  });
});

describe('pickWeighted', () => {
  const origin: readonly WeightedEntry<string>[] = [
    { value: 'standard', weight: 70 },
    { value: 'special', weight: 29 },
    { value: 'pocket-dimension', weight: 1 },
  ];

  // C4
  it('over 100,000 picks of 70/29/1 stays within 1 percentage point of each weight', () => {
    const rng = new SeededRng(7029);
    const counts = new Map<string, number>();
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const value = pickWeighted(origin, rng);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const { value, weight } of origin) {
      const percent = ((counts.get(value) ?? 0) / n) * 100;
      expect(Math.abs(percent - weight)).toBeLessThanOrEqual(1);
    }
  });

  it('gives the same sequence for the same seed', () => {
    const sequence = (seed: number) => {
      const rng = new SeededRng(seed);
      return Array.from({ length: 200 }, () => pickWeighted(origin, rng));
    };
    expect(sequence(99)).toEqual(sequence(99));
    expect(new Set(sequence(99)).size).toBeGreaterThan(1);
  });

  it('never picks a zero-weight entry', () => {
    const rng = new SeededRng(3);
    const table = [
      { value: 'never', weight: 0 },
      { value: 'always', weight: 5 },
    ];
    for (let i = 0; i < 1000; i++) expect(pickWeighted(table, rng)).toBe('always');
  });

  // C5 (table part)
  it('rejects a table whose weights add up to 0, an empty table, and negative or fractional weights', () => {
    const rng = new SeededRng(1);
    expect(codeOf(() => pickWeighted([{ value: 'a', weight: 0 }, { value: 'b', weight: 0 }], rng))).toBe('table');
    expect(codeOf(() => pickWeighted([], rng))).toBe('table');
    expect(codeOf(() => pickWeighted([{ value: 'a', weight: -1 }, { value: 'b', weight: 2 }], rng))).toBe('table');
    expect(codeOf(() => pickWeighted([{ value: 'a', weight: 0.5 }], rng))).toBe('table');
  });
});
