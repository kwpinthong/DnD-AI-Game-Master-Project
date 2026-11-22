import { PHASES } from '@isekai/protocol';

/**
 * GEN-132: the painted place images by place id and period, the ONE table in the app. `eager` + `import: 'default'`
 * gives only the hashed URL of each file (nothing is inlined, nothing is downloaded): the browser fetches a file only
 * when an <img> uses its URL, so the page loads the one image on screen, not all 52.
 */
const FILES = import.meta.glob<string>('../assets/illustrations/place-*.webp', { eager: true, import: 'default' });

/** "inn-eosoria" -> URL. */
export const PLACE_ART_TABLE: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(FILES).map(([path, url]) => [/place-(.+)\.webp$/.exec(path)![1]!, url]));

const KNOWN_PHASES: readonly string[] = PHASES;

/**
 * The image of this place at this period (`phase` as the room sends it, upper case), or null when there is none:
 * a place without art, or a period we do not know, gets the empty frame. A missing period of a place that has art
 * falls back to its EOSORIA image.
 */
export function placeArt(placeId: string | undefined, phase: string | undefined): string | null {
  if (!placeId || !phase || !KNOWN_PHASES.includes(phase)) return null;
  return PLACE_ART_TABLE[`${placeId}-${phase.toLowerCase()}`] ?? PLACE_ART_TABLE[`${placeId}-eosoria`] ?? null;
}
