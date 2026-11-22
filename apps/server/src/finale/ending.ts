import type { EndingPath, PlayerEndingOutcome } from '@isekai/protocol';

/** What the ending rule needs to know about one player at the end. */
export interface EndingPlayerFacts {
  memberId: string;
  /** Holds an S / SS protection buff (skill or item). */
  protectedBy: readonly string[];
  /** At a SAFE_ZONE place when the game ended. */
  inSafeZone: boolean;
}

export interface EndingInput {
  reason: 'finale' | 'game_over';
  /** The path the AI GM said the players completed on day 12; null = none. */
  declaredPath: Exclude<EndingPath, 'none'> | null;
  players: readonly EndingPlayerFacts[];
}

export interface EndingDecision {
  path: EndingPath;
  outcomes: Record<string, PlayerEndingOutcome>;
}

/**
 * World_Timeline day 12 (GEN-059). Good / Evil / Neutral: the impact never comes, so everyone still alive
 * survives (there is no permanent death yet, Q-057: HP 0 = unconscious). No path: the meteor hits; only S /
 * SS protection or a SAFE_ZONE survives (Bad Ending for the rest). A game over (everyone out for good before
 * the finale) is the bad ending for everyone.
 */
export function decideEnding(input: EndingInput): EndingDecision {
  const path: EndingPath = input.reason === 'game_over' ? 'none' : (input.declaredPath ?? 'none');
  const outcomes: Record<string, PlayerEndingOutcome> = {};
  for (const p of input.players) {
    const survives = input.reason === 'finale' && (path !== 'none' || p.protectedBy.length > 0 || p.inSafeZone);
    outcomes[p.memberId] = survives ? 'survived' : 'defeated';
  }
  return { path, outcomes };
}
