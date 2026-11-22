// GEN-089 tab logic (kept for the phone layout, GEN-123). The old three-column tab bar was replaced by the chat page (GEN-122).
import type { RoomEntry } from '@isekai/protocol';
import { describe, expect, it } from 'vitest';
import { dotTabs, tabCounts } from '../src/play/tabs.ts';

const entry = (kind: RoomEntry['kind'], extra: Partial<RoomEntry> = {}) => ({ seq: 1, kind, place: null, text: 'x', ...extra }) as RoomEntry;

describe('tab logic', () => {
  it('counts the feed for สถานที่ and everything yours alone (not your own whisper) for ส่วนตัว', () => {
    const entries = [entry('feed'), entry('narration'), entry('hit'), entry('whisper', { whisper: { mine: true } as RoomEntry['whisper'] }), entry('whisper', { whisper: { mine: false } as RoomEntry['whisper'] })];
    expect(tabCounts(entries)).toMatchObject({ place: 1, private: 3 });
  });

  it('a dot only for a tab that is not open and has more than it had', () => {
    const counts = { place: 2, private: 3, self: 0, action: 0 };
    const seen = { place: 2, private: 1, self: 0, action: 0 };
    expect([...dotTabs(counts, seen, 'place')]).toEqual(['private']);
    expect([...dotTabs(counts, seen, 'private')]).toEqual([]);
  });
});
