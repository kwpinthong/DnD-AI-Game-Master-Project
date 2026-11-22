import { FALLBACK_NARRATION_LABEL, type RoomEntry, type RoomState } from '@isekai/protocol';
import { useId, useState, type FormEvent } from 'react';
import secretIcon from '../assets/icons/visibility-secret.svg';
import { hitChangeText, rollLine } from '../screen-models.ts';
import { Button, HitCard, MaskIcon, playText } from '../ui/index.ts';
import { EntryGroups } from './PlaceColumn.tsx';
import { TurnChangesList } from './TurnChanges.tsx';

const t = playText;

const changesOf = (e: RoomEntry): string => (e.hit ? e.hit.changes.map(hitChangeText).join(' / ') : '');

/** One private entry: a narration with its roll (F5), an omen you received, or a hit you have acknowledged. */
function StoryEntry({ entry, who }: { entry: RoomEntry; who: boolean }) {
  const [open, setOpen] = useState(false);
  const factorsId = useId();
  if (entry.kind === 'changes') {
    return (
      <li className="play-entry play-entry--changes">
        <span className="play-entry__tag">{t.changes.kind}</span>
        <TurnChangesList entry={entry} who={who} />
      </li>
    );
  }
  return (
    <li className={entry.kind === 'hit' ? 'play-entry play-entry--hit' : 'play-entry'}>
      {entry.kind === 'hit' && <span className="play-entry__tag">{t.private.acknowledged}</span>}
      {entry.kind === 'omen' && <span className="play-entry__tag">{t.omen.received}</span>}
      {entry.fallback && <small className="fallback-label">{FALLBACK_NARRATION_LABEL}</small>}
      <p>{entry.text}</p>
      {entry.kind === 'hit' && entry.hit && <small>{changesOf(entry)}</small>}
      {entry.roll && (
        <div className="play-roll">
          <span>{rollLine(entry.roll)}</span>
          {entry.roll.factors.length > 0 && (
            <Button aria-expanded={open} aria-controls={factorsId} onClick={() => setOpen((v) => !v)}>
              {t.private.why}
            </Button>
          )}
          {open && (
            <ul id={factorsId} className="play-factors" aria-label={t.private.factors}>
              {entry.roll.factors.map((f, i) => (
                <li key={i}>{`${t.private.dir[f.dir]} ${f.label}`}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** The Whisper being written; the room owns it and empties it when the server accepts the Whisper. */
export interface WhisperText {
  text: string;
  setText: (text: string) => void;
}

function Whispers({
  whispers,
  allies,
  canSend,
  problem,
  onSend,
  text,
  setText,
}: {
  whispers: RoomEntry[];
  allies: RoomState['you']['allies'];
  canSend: boolean;
  problem: string | undefined;
  onSend: (to: string) => void;
} & WhisperText) {
  const [to, setTo] = useState('');
  const toId = useId();
  const textId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    onSend(to || allies[0]!.ref);
  }

  return (
    <>
      {canSend &&
        (allies.length === 0 ? (
          <p className="muted">{t.whisper.noAlly}</p>
        ) : (
          <form className="play-whisper" aria-label={t.whisper.form} onSubmit={submit}>
            <label htmlFor={toId}>{t.whisper.to}</label>
            <select id={toId} value={to || allies[0]!.ref} onChange={(e) => setTo(e.target.value)}>
              {allies.map((a) => (
                <option key={a.ref} value={a.ref}>
                  {a.name}
                </option>
              ))}
            </select>
            <label htmlFor={textId}>{t.whisper.text}</label>
            <textarea id={textId} value={text} rows={2} onChange={(e) => setText(e.target.value)} />
            <Button type="submit">{t.whisper.send}</Button>
            {problem && <p role="alert">{problem}</p>}
          </form>
        ))}
      {whispers.length === 0 ? (
        <p className="muted">{t.whisper.none}</p>
      ) : (
        <ol className="play-entries">
          {whispers.map((e) => (
            <li key={e.seq} className="play-entry">
              <p>{e.whisper?.mine ? t.whisper.mine(e.whisper.to, e.text) : t.whisper.theirs(e.whisper?.from ?? '', e.text)}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/**
 * The right column (340), yours alone: the hit card pinned on top until [รับทราบ] (4.5, GEN-060), then your
 * story (private narration + roll) and Whisper as two tabs.
 */
export function PrivateColumn({
  entries,
  you,
  acknowledged,
  onAcknowledge,
  whisper,
  whisperProblem,
  onWhisper,
}: {
  entries: readonly RoomEntry[];
  you: RoomState['you'];
  /** `seq` of the hits the player has acknowledged (kept on the client, docs/contract.md). */
  acknowledged: ReadonlySet<number>;
  onAcknowledge: (seq: number) => void;
  whisper: WhisperText;
  whisperProblem: string | undefined;
  onWhisper: (to: string) => void;
}) {
  const [tab, setTab] = useState<'story' | 'whisper'>('story');
  const [seenWhispers, setSeenWhispers] = useState(0);
  const ids = useId();
  const pinned = entries.filter((e) => e.kind === 'hit' && !acknowledged.has(e.seq));
  const story = entries.filter((e) => e.kind === 'narration' || e.kind === 'omen' || e.kind === 'changes' || (e.kind === 'hit' && acknowledged.has(e.seq)));
  const whispers = entries.filter((e) => e.kind === 'whisper');
  const received = whispers.filter((w) => !w.whisper?.mine).length;
  const unread = tab === 'whisper' ? 0 : Math.max(0, received - seenWhispers);
  const first = pinned[0];

  function pick(next: 'story' | 'whisper') {
    setTab(next);
    setSeenWhispers(received);
  }

  return (
    <aside className="play-private" aria-label={t.private.column}>
      <p className="badge badge--secret play-private__label">
        <MaskIcon src={secretIcon} />
        {t.private.onlyYou}
      </p>
      {first && (
        <div className="play-pin" aria-live="polite">
          <HitCard actor={first.hit?.actor ?? null} onAcknowledge={() => onAcknowledge(first.seq)}>
            {first.text}
            {first.hit && first.hit.changes.length > 0 && <span className="play-pin__changes">{changesOf(first)}</span>}
          </HitCard>
          {pinned.length > 1 && <p className="play-pin__more">{t.private.moreHits(pinned.length - 1)}</p>}
        </div>
      )}
      <div className="play-tabs" role="tablist">
        <button type="button" role="tab" id={`${ids}story-tab`} aria-selected={tab === 'story'} aria-controls={`${ids}story`} onClick={() => pick('story')}>
          {t.private.story}
        </button>
        <button type="button" role="tab" id={`${ids}whisper-tab`} aria-selected={tab === 'whisper'} aria-controls={`${ids}whisper`} onClick={() => pick('whisper')}>
          {unread > 0 ? `${t.private.whisper} ${unread}` : t.private.whisper}
        </button>
      </div>
      <section id={`${ids}story`} className="play-story" aria-label={t.private.story} hidden={tab !== 'story'}>
        <EntryGroups entries={story} empty={t.private.empty}>
          {(e) => <StoryEntry key={e.seq} entry={e} who={you.role === 'gm'} />}
        </EntryGroups>
      </section>
      <section id={`${ids}whisper`} className="play-story play-scroll" aria-label={t.private.whisper} hidden={tab !== 'whisper'}>
        <Whispers whispers={whispers} allies={you.allies} canSend={you.role === 'player' && !you.astral} problem={whisperProblem} onSend={onWhisper} {...whisper} />
      </section>
    </aside>
  );
}
