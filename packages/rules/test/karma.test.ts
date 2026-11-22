import { describe, expect, it } from 'vitest';
import { karmaTierProblems, karmaTitle, revealsPlayerName, type KarmaTier } from '../src/index.ts';

/** A small band list in the sheet's shape (the real one is checked on the server against the asset JSON). */
const TIERS: KarmaTier[] = [
  { min: -100, max: -14, title: 'ชั่ว' },
  { min: -13, max: -1, title: 'กลาง' },
  { min: 0, max: 0, title: 'กลางสุดๆ' },
  { min: 1, max: 13, title: 'กลาง' },
  { min: 14, max: 100, title: 'ดี' },
];

describe('karma adjectives (GEN-067)', () => {
  it.each([
    [-100, 'ชั่ว'],
    [-14, 'ชั่ว'],
    [-13, 'กลาง'],
    [0, 'กลางสุดๆ'],
    [13, 'กลาง'],
    [14, 'ดี'],
    [100, 'ดี'],
  ])('C1: karma %i is "%s"', (karma, title) => {
    expect(karmaTitle(karma, TIERS)).toBe(title);
  });

  it('C1: a value outside -100..+100 reads as the nearest end', () => {
    expect(karmaTitle(250, TIERS)).toBe('ดี');
    expect(karmaTitle(-250, TIERS)).toBe('ชั่ว');
  });

  it('a usable band list has no problems', () => {
    expect(karmaTierProblems(TIERS)).toEqual([]);
  });

  it('a gap, an overlap, a range that misses an end or an empty title is a problem', () => {
    expect(karmaTierProblems(TIERS.filter((t) => t.min !== 0))).not.toEqual([]);
    expect(karmaTierProblems([...TIERS, { min: 50, max: 60, title: 'ซ้ำ' }])).not.toEqual([]);
    expect(karmaTierProblems(TIERS.slice(1))).not.toEqual([]);
    expect(karmaTierProblems(TIERS.map((t) => (t.min === 14 ? { ...t, title: ' ' } : t)))).not.toEqual([]);
    expect(karmaTierProblems([])).not.toEqual([]);
  });
});

describe('Title Mask between players (GEN-067)', () => {
  it('C4: allies at relationship +10 see the real name; +9 or not allied do not', () => {
    expect(revealsPlayerName({ alliance: true, relationship: 10 })).toBe(true);
    expect(revealsPlayerName({ alliance: true, relationship: 9 })).toBe(false);
    expect(revealsPlayerName({ alliance: false, relationship: 50 })).toBe(false);
    expect(revealsPlayerName(undefined)).toBe(false);
  });
});
