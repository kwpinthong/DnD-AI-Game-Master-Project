/** players = role-player members of the whole game who were not kicked (never the Human GM). */
export interface VoteFacts {
  players: number;
  up: number;
  down: number;
}
export type VoteVerdict = 'good' | 'avoid' | 'none';

/**
 * GEN-079 (ADR Learning Across Games R2): the one verdict for an AI message or a ruling, computed live on
 * every read. Both cannot hold at once (up + down ≤ players), so the order does not matter.
 */
export function voteVerdict({ players, up, down }: VoteFacts): VoteVerdict {
  if (players <= 0) return 'none';
  if (up * 2 > players) return 'good'; // Q-286: a non-voter counts as 👎, so 👍 must pass half; a tie fails
  if (down * 2 > players) return 'avoid'; // Q-287: real 👎 past half, non-voters not counted
  return 'none';
}
