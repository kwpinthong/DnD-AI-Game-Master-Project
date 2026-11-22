import { describe, expect, it } from 'vitest';
import { injuryText, revealsNpcName } from '../src/index.ts';

describe('visibility rules (GEN-050)', () => {
  it('C7: HP 100, 1 and 0 give the Rules Spec injury words (HP 0 = หมดสติ, no death)', () => {
    expect(injuryText(100)).toBe('ปกติ');
    expect(injuryText(1)).toBe('สาหัส');
    expect(injuryText(0)).toBe('หมดสติ');
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
    expect(injuryText(hp)).toBe(text);
  });

  it('C4: a grade B NPC reveals its name at affinity +9, not +8', () => {
    expect(revealsNpcName('B', 8)).toBe(false);
    expect(revealsNpcName('B', 9)).toBe(true);
    expect(revealsNpcName('B', 40)).toBe(true);
  });
});
