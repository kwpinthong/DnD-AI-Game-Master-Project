import type { EndingPath, PlayerEndingOutcome } from '@isekai/protocol';
import { KARMA_MAX, type KarmaTier } from '@isekai/rules';

/** What the ending rule needs to know about one player at the end. */
export interface EndingPlayerFacts {
  memberId: string;
  /** Holds an S / SS protection buff (skill or item). */
  protectedBy: readonly string[];
  /** At a SAFE_ZONE place when the game ended. */
  inSafeZone: boolean;
  /** On the Good side of the karma tiers (`goodSideMin`): the Evil path defeats them (Q-204). */
  goodAligned: boolean;
}

/**
 * The lowest karma of the Good side of the karma tiers (GEN-067, Q-204): the first band above the neutral
 * band, i.e. the first band from +1 up whose word is not the word at +1. With the sheet's bands that is +14
 * (neutral is -13..+13), the same line Day10_Strategies uses for "ฝ่ายดี". No such band = nobody is Good.
 */
export function goodSideMin(tiers: readonly KarmaTier[]): number {
  const neutral = tiers.find((t) => t.min <= 1 && t.max >= 1)?.title;
  return tiers.find((t) => t.min > 1 && t.title !== neutral)?.min ?? KARMA_MAX + 1;
}

/**
 * The highest karma of the Evil side (GEN-093, mirror of `goodSideMin`): the last band below -1 whose word is
 * not the word at -1. With the sheet's bands that is -14. No such band = nobody is Evil.
 */
export function evilSideMax(tiers: readonly KarmaTier[]): number {
  const neutral = tiers.find((t) => t.min <= -1 && t.max >= -1)?.title;
  const below = tiers.filter((t) => t.max < -1 && t.title !== neutral).map((t) => t.max);
  return below.length > 0 ? Math.max(...below) : -KARMA_MAX - 1;
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
 * World_Timeline day 12 (GEN-059). Good / Neutral: the impact never comes, so everyone still alive survives
 * (there is no permanent death yet, Q-057: HP 0 = unconscious). Evil (Q-204): the meteor's power is taken by
 * Evil; the Good side (`goodAligned`) loses whatever protects them, everyone else survives. No path: the meteor hits; only S /
 * SS protection or a SAFE_ZONE survives (Bad Ending for the rest). A game over (everyone out for good before
 * the finale) is the bad ending for everyone.
 */
export function decideEnding(input: EndingInput): EndingDecision {
  const path: EndingPath = input.reason === 'game_over' ? 'none' : (input.declaredPath ?? 'none');
  const outcomes: Record<string, PlayerEndingOutcome> = {};
  for (const p of input.players) {
    const survives =
      input.reason === 'finale' &&
      (path === 'evil' ? !p.goodAligned : path !== 'none' || p.protectedBy.length > 0 || p.inSafeZone);
    outcomes[p.memberId] = survives ? 'survived' : 'defeated';
  }
  return { path, outcomes };
}
