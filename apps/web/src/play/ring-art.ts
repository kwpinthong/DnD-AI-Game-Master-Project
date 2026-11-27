import type { NpcLineView } from '@isekai/protocol';
import ringA from '../assets/frames/avatar-ring-a.webp';
import ringB from '../assets/frames/avatar-ring-b.webp';
import ringF from '../assets/frames/avatar-ring-f.webp';
import ringPlayer from '../assets/frames/avatar-ring-player.webp';
import ringS from '../assets/frames/avatar-ring-s.webp';
import ringSs from '../assets/frames/avatar-ring-ss.webp';

/** ISK-005 preset pictures by file name: `avatar-NN.webp` (256 px) and `avatar-NN@2x.webp` (512 px). */
const AVATAR_FILES = import.meta.glob<string>('../assets/avatars/avatar-*.webp', { eager: true, import: 'default' });

/** The picture of a preset avatar (`src` + 2x `srcSet`); null for no avatar (a character made before ISK-006) or an unknown id. */
export function avatarArt(avatarId: string | null | undefined): { src: string; srcSet: string } | null {
  const src = avatarId ? AVATAR_FILES[`../assets/avatars/${avatarId}.webp`] : undefined;
  if (!src) return null;
  const big = AVATAR_FILES[`../assets/avatars/${avatarId}@2x.webp`];
  return { src, srcSet: big ? `${src} 1x, ${big} 2x` : src };
}

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
