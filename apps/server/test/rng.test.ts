import { pickWeighted, rollDice, rollRange } from '@isekai/rules';
import { describe, expect, it } from 'vitest';
import { CryptoRng } from '../src/rng.ts';

// The production RNG goes through the same checks as SeededRng in @isekai/rules (C2, C3, C4).
describe('CryptoRng', () => {
  const rng = new CryptoRng();

  it.each([20, 100])('rolls d%i 10,000 times hitting every face and nothing outside', (sides) => {
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) seen.add(rollDice(`d${sides}`, rng).faces[0]!);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(sides);
    expect(seen.size).toBe(sides);
  });

  it('rolls 15..25 10,000 times hitting both ends and nothing outside', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) seen.add(rollRange(15, 25, rng));
    expect([...seen].sort((a, b) => a - b)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  });

  it('picks origin 70/29/1 100,000 times within 1 percentage point of each weight', () => {
    const table = [
      { value: 'standard', weight: 70 },
      { value: 'special', weight: 29 },
      { value: 'pocket-dimension', weight: 1 },
    ];
    const counts = new Map<string, number>();
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const value = pickWeighted(table, rng);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const { value, weight } of table) {
      expect(Math.abs(((counts.get(value) ?? 0) / n) * 100 - weight)).toBeLessThanOrEqual(1);
    }
  });

  it('returns min when min equals max', () => {
    expect(rng.nextInt(5, 5)).toBe(5);
  });

  it('rejects bounds that are not whole numbers, are reversed, or span more than randomInt allows', () => {
    expect(() => rng.nextInt(3, 1)).toThrow(RangeError);
    expect(() => rng.nextInt(0.5, 2)).toThrow(RangeError);
    expect(() => rng.nextInt(0, 2 ** 48)).toThrow(RangeError);
  });
});
