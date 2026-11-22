import type { RoomEntry } from '@isekai/protocol';
import { hitChangeText } from '../../screen-models.ts';
import { HitCard, playText } from '../../ui/index.ts';

/** "เกิดกับคุณ": another player's act that landed on you stays pinned over the feed until [รับทราบ] (GEN-060). */
export function HitPin({ pinned, onAcknowledge }: { pinned: readonly RoomEntry[]; onAcknowledge: (seq: number) => void }) {
  const first = pinned[0];
  if (!first) return null;
  return (
    <div className="play-pin" aria-live="polite">
      <HitCard actor={first.hit?.actor ?? null} onAcknowledge={() => onAcknowledge(first.seq)}>
        {first.text}
        {first.hit && first.hit.changes.length > 0 && <span className="play-pin__changes">{first.hit.changes.map(hitChangeText).join(' / ')}</span>}
      </HitCard>
      {pinned.length > 1 && <p className="play-pin__more">{playText.private.moreHits(pinned.length - 1)}</p>}
    </div>
  );
}
