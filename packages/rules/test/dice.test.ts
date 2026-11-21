import { describe, expect, it } from 'vitest';
import { SeededRng, rollDie } from '../src/index.ts';

describe('rollDie', () => {
  it('rolls 1d20 with a SeededRng to the same expected values every time', () => {
    const rolls = (seed: number) => {
      const rng = new SeededRng(seed);
      return Array.from({ length: 5 }, () => rollDie(20, rng));
    };

    expect(rolls(42)).toEqual([13, 9, 18, 14, 4]);
    expect(rolls(42)).toEqual(rolls(42));
  });

  it('stays within 1..sides over many rolls', () => {
    const rng = new SeededRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = rollDie(6, rng);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects a die with fewer than 1 side or a fractional side count', () => {
    const rng = new SeededRng(1);
    expect(() => rollDie(0, rng)).toThrow(RangeError);
    expect(() => rollDie(2.5, rng)).toThrow(RangeError);
  });
});
