import type { RoomEntry } from '@isekai/protocol';
import { turnChangeText } from '../screen-models.ts';
import { playText } from '../ui/index.ts';

const t = playText.changes;

/** GEN-114: what changed in your own values in one turn and why (numbers from the server). Nothing changed = one quiet line. */
export function TurnChangesList({ entry, who = false }: { entry: RoomEntry; who?: boolean }) {
  const changes = entry.changes ?? [];
  return (
    <>
      {who && <strong className="play-changes__who">{entry.text}</strong>}
      {changes.length === 0 ? (
        <span className="muted">{t.none}</span>
      ) : (
        <ul className="play-changes" aria-label={t.label}>
          {changes.map((c, i) => (
            <li key={i}>{turnChangeText(c)}</li>
          ))}
        </ul>
      )}
    </>
  );
}
