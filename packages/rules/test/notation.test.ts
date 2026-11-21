import { describe, expect, it } from 'vitest';
import { RollError, SeededRng, rollDice, type Rng } from '../src/index.ts';

/** An Rng that always lands on the given face, clamped into the requested range. */
function fixedRng(face: number): Rng {
  return { nextInt: (min, max) => Math.min(max, Math.max(min, face)) };
}

describe('rollDice', () => {
  // C1
  it('rolls "d20+4" with a seeded RNG to the expected face and total', () => {
    const roll = rollDice('d20+4', new SeededRng(42));

    expect(roll).toEqual({
      notation: '1d20+4',
      count: 1,
      sides: 20,
      modifier: 4,
      faces: [13],
      total: 17,
      crit: false,
      fumble: false,
    });
  });

  it('returns every face of a multi-die roll and sums them with the modifier', () => {
    const roll = rollDice('3d6-2', new SeededRng(42));

    expect(roll.faces).toHaveLength(3);
    for (const face of roll.faces) {
      expect(face).toBeGreaterThanOrEqual(1);
      expect(face).toBeLessThanOrEqual(6);
    }
    expect(roll.total).toBe(roll.faces.reduce((a, b) => a + b, 0) - 2);
    expect(roll.notation).toBe('3d6-2');
  });

  // C6
  it('flags a natural 20 on a d20 as crit, whatever the modifier', () => {
    const roll = rollDice('d20-5', fixedRng(20));
    expect(roll.faces).toEqual([20]);
    expect(roll.total).toBe(15);
    expect(roll.crit).toBe(true);
    expect(roll.fumble).toBe(false);
  });

  it('flags a natural 1 on a d20 as fumble, whatever the modifier', () => {
    const roll = rollDice('d20+10', fixedRng(1));
    expect(roll.faces).toEqual([1]);
    expect(roll.total).toBe(11);
    expect(roll.fumble).toBe(true);
    expect(roll.crit).toBe(false);
  });

  it('does not flag 19 or 2 (no widened range) nor 20s on dice other than a single d20', () => {
    expect(rollDice('d20', fixedRng(19))).toMatchObject({ crit: false, fumble: false });
    expect(rollDice('d20', fixedRng(2))).toMatchObject({ crit: false, fumble: false });
    expect(rollDice('d100', fixedRng(20))).toMatchObject({ crit: false, fumble: false });
    expect(rollDice('d100', fixedRng(1))).toMatchObject({ crit: false, fumble: false });
    expect(rollDice('2d20', fixedRng(20))).toMatchObject({ crit: false, fumble: false });
  });

  // C7
  it('treats "2D6 + 3" the same as "2d6+3"', () => {
    const loose = rollDice('2D6 + 3', new SeededRng(9));
    const strict = rollDice('2d6+3', new SeededRng(9));

    expect(loose).toEqual(strict);
    expect(loose.notation).toBe('2d6+3');
  });

  // C5 (notation part)
  it.each([
    ['0d6', 'count'],
    ['d0', 'sides'],
    ['101d6', 'count'],
    ['2d6++', 'syntax'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['d', 'syntax'],
    ['2d6+3d4', 'syntax'],
    ['abc', 'syntax'],
  ] as const)('rejects %j with a %s RollError that names the input', (notation, code) => {
    let caught: unknown;
    try {
      rollDice(notation, new SeededRng(1));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RollError);
    expect((caught as RollError).code).toBe(code);
    if (notation.trim() !== '') expect((caught as RollError).message).toContain(JSON.stringify(notation));
  });
});
