import { describe, expect, it } from 'vitest';
import { karmaTitle } from '@isekai/rules';
import { loadGameAssets } from '../src/assets/load.ts';
import { decideEnding, goodSideMin, type EndingPlayerFacts } from '../src/finale/ending.ts';

/** GEN-059: the ending rule (World_Timeline day 12), as a pure function. */
const plain = (memberId: string, extra: Partial<EndingPlayerFacts> = {}): EndingPlayerFacts => ({
  memberId,
  protectedBy: [],
  inSafeZone: false,
  goodAligned: false,
  ...extra,
});

describe('GEN-059 ending rule', () => {
  it('C2: a completed Good path protects the town: everyone still alive survives', () => {
    const out = decideEnding({ reason: 'finale', declaredPath: 'good', players: [plain('a'), plain('b'), plain('c')] });
    expect(out).toEqual({ path: 'good', outcomes: { a: 'survived', b: 'survived', c: 'survived' } });
  });

  it('C2: the Neutral path cancels the impact: everyone survives, Good side included', () => {
    expect(decideEnding({ reason: 'finale', declaredPath: 'neutral', players: [plain('a', { goodAligned: true }), plain('b')] })).toEqual({
      path: 'neutral',
      outcomes: { a: 'survived', b: 'survived' },
    });
  });

  it('Q-204: the Evil path takes the meteor power: the Good side loses (protection or a SAFE_ZONE does not help), the others survive', () => {
    const out = decideEnding({
      reason: 'finale',
      declaredPath: 'evil',
      players: [plain('a', { goodAligned: true, protectedBy: ['Sanctuary Aegis'], inSafeZone: true }), plain('b'), plain('c', { goodAligned: true })],
    });
    expect(out).toEqual({ path: 'evil', outcomes: { a: 'defeated', b: 'survived', c: 'defeated' } });
  });

  it('Q-204: the Good side starts at the first tier above the neutral band (+14 in the sheet)', () => {
    const tiers = loadGameAssets().karmaTiers;
    expect(goodSideMin(tiers)).toBe(14);
    // The band below is the neutral word, the one from +14 is not.
    expect(karmaTitle(13, tiers)).toBe(karmaTitle(1, tiers));
    expect(karmaTitle(14, tiers)).not.toBe(karmaTitle(13, tiers));
    // Made-up bands: the rule reads the data, not a fixed number.
    const custom = [
      { min: -100, max: -21, title: 'ชั่ว' },
      { min: -20, max: 20, title: 'กลาง' },
      { min: 21, max: 100, title: 'ดี' },
    ];
    expect(goodSideMin(custom)).toBe(21);
  });

  it('C3: no path succeeded: the meteor hits; S / SS protection or a SAFE_ZONE survives, everyone else is defeated', () => {
    const out = decideEnding({
      reason: 'finale',
      declaredPath: null,
      players: [plain('a', { protectedBy: ['Sanctuary Aegis'] }), plain('b', { inSafeZone: true }), plain('c')],
    });
    expect(out).toEqual({ path: 'none', outcomes: { a: 'survived', b: 'survived', c: 'defeated' } });
  });

  it('C6: a game over is the bad ending for everyone, whatever they hold or where they are', () => {
    const out = decideEnding({
      reason: 'game_over',
      declaredPath: 'good',
      players: [plain('a', { protectedBy: ['I AM UNTOUCHED'] }), plain('b', { inSafeZone: true })],
    });
    expect(out).toEqual({ path: 'none', outcomes: { a: 'defeated', b: 'defeated' } });
  });
});
