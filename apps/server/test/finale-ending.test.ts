import { describe, expect, it } from 'vitest';
import { decideEnding, type EndingPlayerFacts } from '../src/finale/ending.ts';

/** GEN-059: the ending rule (World_Timeline day 12), as a pure function. */
const plain = (memberId: string, extra: Partial<EndingPlayerFacts> = {}): EndingPlayerFacts => ({ memberId, protectedBy: [], inSafeZone: false, ...extra });

describe('GEN-059 ending rule', () => {
  it('C2: a completed Good path protects the town: everyone still alive survives', () => {
    const out = decideEnding({ reason: 'finale', declaredPath: 'good', players: [plain('a'), plain('b'), plain('c')] });
    expect(out).toEqual({ path: 'good', outcomes: { a: 'survived', b: 'survived', c: 'survived' } });
  });

  it('C2: the Evil and Neutral paths also stop the impact (nobody is hit)', () => {
    for (const path of ['evil', 'neutral'] as const) {
      expect(decideEnding({ reason: 'finale', declaredPath: path, players: [plain('a'), plain('b')] })).toEqual({
        path,
        outcomes: { a: 'survived', b: 'survived' },
      });
    }
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
