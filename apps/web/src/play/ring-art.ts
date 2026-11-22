import type { NpcLineView } from '@isekai/protocol';
import ringA from '../assets/frames/avatar-ring-a.webp';
import ringB from '../assets/frames/avatar-ring-b.webp';
import ringF from '../assets/frames/avatar-ring-f.webp';
import ringPlayer from '../assets/frames/avatar-ring-player.webp';
import ringS from '../assets/frames/avatar-ring-s.webp';
import ringSs from '../assets/frames/avatar-ring-ss.webp';

export type RingKey = 'f' | 'b' | 'a' | 's' | 'ss' | 'player';
export const RING_ART: Readonly<Record<RingKey, string>> = { f: ringF, b: ringB, a: ringA, s: ringS, ss: ringSs, player: ringPlayer };

/**
 * Which ring an avatar wears (GEN-132): our own character = player; an NPC = its grade, only when the payload gave it
 * (it does so only once the viewer knows the NPC); no grade known, or another player = the neutral B ring, so a hidden
 * grade is never shown.
 */
export function ringFor(opts: { own?: boolean; grade?: NpcLineView['grade'] | undefined }): RingKey {
  if (opts.own) return 'player';
  return opts.grade ? (opts.grade.toLowerCase() as RingKey) : 'b';
}
