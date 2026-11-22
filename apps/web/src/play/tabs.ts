import type { RoomEntry } from '@isekai/protocol';

/** GEN-086: the Play screen on a phone (< 768) is one of these at a time; the same components as desktop. */
export const PLAY_TABS = ['place', 'private', 'self', 'action'] as const;
export type PlayTab = (typeof PLAY_TABS)[number];

/** How many things each tab has had so far: the public feed, and everything that is yours alone (story, omen, whisper you received, hit). */
export function tabCounts(entries: readonly RoomEntry[]): Record<PlayTab, number> {
  const feed = entries.filter((e) => e.kind === 'feed').length;
  const mine = entries.filter((e) => e.kind !== 'feed' && !(e.kind === 'whisper' && e.whisper?.mine)).length;
  return { place: feed, private: mine, self: 0, action: 0 };
}

/** A tab shows a dot when it has more than when it was last open, and it is not the open one. */
export function dotTabs(counts: Record<PlayTab, number>, seen: Record<PlayTab, number>, active: PlayTab): ReadonlySet<PlayTab> {
  return new Set(PLAY_TABS.filter((tab) => tab !== active && counts[tab] > seen[tab]));
}
