import { describe, expect, it } from 'vitest';
import { injuryText, revealsNpcName } from '../src/index.ts';

describe('visibility rules (GEN-050)', () => {
  it('C7: HP 100, 1 and 0 give the Rules Spec injury words (HP 0 = หมดสติ, no death)', () => {
    expect(injuryText(100, 100)).toBe('ปกติ');
    expect(injuryText(1, 100)).toBe('สาหัส');
    expect(injuryText(0, 100)).toBe('หมดสติ');
  });

  it.each([
    [100, 'ปกติ'],
    [50, 'ปกติ'],
    [49, 'บาดเจ็บ'],
    [25, 'บาดเจ็บ'],
    [24, 'สาหัส'],
    [1, 'สาหัส'],
    [0, 'หมดสติ'],
  ])('C7: band edge HP %i is "%s"', (hp, text) => {
    expect(injuryText(hp, 100)).toBe(text);
  });

  it('Q-197: full HP is ปกติ at every Max HP a character can have (30..45), and the bands are shares of Max HP', () => {
    for (let max = 30; max <= 45; max++) {
      expect(injuryText(max, max), `${max}/${max}`).toBe('ปกติ');
      expect(injuryText(Math.ceil(max / 2), max)).toBe('ปกติ');
      expect(injuryText(Math.ceil(max / 2) - 1, max)).toBe('บาดเจ็บ');
      expect(injuryText(Math.ceil(max / 4), max)).toBe('บาดเจ็บ');
      expect(injuryText(Math.ceil(max / 4) - 1, max)).toBe('สาหัส');
      expect(injuryText(1, max)).toBe('สาหัส');
      expect(injuryText(0, max)).toBe('หมดสติ');
    }
    // Max 30: 15 is half, 14 is not; 8 is a quarter (7.5), 7 is not.
    expect([15, 14, 8, 7].map((hp) => injuryText(hp, 30))).toEqual(['ปกติ', 'บาดเจ็บ', 'บาดเจ็บ', 'สาหัส']);
  });

  it('C4: a grade B NPC reveals its name at affinity +9, not +8', () => {
    expect(revealsNpcName('B', 8)).toBe(false);
    expect(revealsNpcName('B', 9)).toBe(true);
    expect(revealsNpcName('B', 40)).toBe(true);
  });
});
