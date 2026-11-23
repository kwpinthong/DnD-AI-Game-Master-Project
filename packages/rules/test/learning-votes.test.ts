import { describe, expect, it } from 'vitest';
import { voteVerdict, type VoteVerdict } from '../src/index.ts';

/** GEN-079 (Q-286 / Q-287 / Q-315): one verdict per AI message or ruling, out of every player of the game. */
describe('GEN-079 voteVerdict', () => {
  // [players, up, down, verdict]; non-voters = players - up - down.
  const cases: [string, number, number, number, VoteVerdict][] = [
    ['C1 4 players 👍3 👎0 none1', 4, 3, 0, 'good'],
    ['C2 4 players 👍2 👎2', 4, 2, 2, 'none'],
    ['C3 4 players 👍2 none2', 4, 2, 0, 'none'],
    ['C4 4 players 👍1 👎3', 4, 1, 3, 'avoid'],
    ['C5 4 players 👎2 none2', 4, 0, 2, 'none'],
    ['C6 3 players 👍1 👎1 none1', 3, 1, 1, 'none'],
    ['C7 5 players 👍3 none2', 5, 3, 0, 'good'],
    ['C7 5 players 👎3 none2', 5, 0, 3, 'avoid'],
    ['C7 5 players 👍2 👎2 none1', 5, 2, 2, 'none'],
    ['C8 nobody voted', 4, 0, 0, 'none'],
    ['C9 Single 👍', 1, 1, 0, 'good'],
    ['C9 Single 👎', 1, 0, 1, 'avoid'],
    ['C9 Single none', 1, 0, 0, 'none'],
    ['C10 4 players, 1 kicked → 3, 👍2', 3, 2, 0, 'good'],
    ['C12 private message, 4 players, 👍1', 4, 1, 0, 'none'],
    ['no players at all', 0, 0, 0, 'none'],
  ];
  it.each(cases)('%s → players %i up %i down %i = %s', (_name, players, up, down, verdict) => {
    expect(voteVerdict({ players, up, down })).toBe(verdict);
  });

  // C11: the R2 table of the ADR "Learning Across Games" (players, 👍, 👎, none, verdict).
  const R2: [number, number, number, number, VoteVerdict][] = [
    [1, 1, 0, 0, 'good'],
    [1, 0, 1, 0, 'avoid'],
    [1, 0, 0, 1, 'none'],
    [2, 2, 0, 0, 'good'],
    [2, 1, 1, 0, 'none'],
    [2, 1, 0, 1, 'none'],
    [2, 0, 2, 0, 'avoid'],
    [3, 2, 1, 0, 'good'],
    [3, 2, 0, 1, 'good'],
    [3, 1, 1, 1, 'none'],
    [3, 0, 2, 1, 'avoid'],
    [3, 0, 1, 2, 'none'],
    [4, 3, 1, 0, 'good'],
    [4, 3, 0, 1, 'good'],
    [4, 2, 2, 0, 'none'],
    [4, 2, 0, 2, 'none'],
    [4, 1, 3, 0, 'avoid'],
    [4, 0, 2, 2, 'none'],
    [4, 0, 0, 4, 'none'],
    [5, 3, 0, 2, 'good'],
    [5, 2, 2, 1, 'none'],
    [5, 2, 0, 3, 'none'],
    [5, 0, 3, 2, 'avoid'],
    [5, 1, 2, 2, 'none'],
  ];
  it.each(R2)('C11 R2 row: %i players 👍%i 👎%i none%i = %s', (players, up, down, none, verdict) => {
    expect(up + down + none).toBe(players);
    expect(voteVerdict({ players, up, down })).toBe(verdict);
  });

  it('C11: the need column = floor(players / 2) + 1 for both sides', () => {
    for (const players of [1, 2, 3, 4, 5]) {
      const need = Math.floor(players / 2) + 1;
      expect(voteVerdict({ players, up: need, down: 0 })).toBe('good');
      expect(voteVerdict({ players, up: need - 1, down: 0 })).toBe('none');
      expect(voteVerdict({ players, up: 0, down: need })).toBe('avoid');
      expect(voteVerdict({ players, up: 0, down: need - 1 })).toBe('none');
    }
  });

  it('C15: one player switching 👍 to 👎 (👍3 → 👍2 of 4) turns good into none on the next read', () => {
    expect(voteVerdict({ players: 4, up: 3, down: 0 })).toBe('good');
    expect(voteVerdict({ players: 4, up: 2, down: 1 })).toBe('none');
  });
});
