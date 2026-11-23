import { FALLBACK_NARRATION_LABEL, PHASES, type EntryVote, type RoomEntry, type RoomState } from '@isekai/protocol';
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { hitChangeText } from '../../screen-models.ts';
import { VoteButtons, playText } from '../../ui/index.ts';
import { FeedDivider, NarrationLine, NpcBubble, OwnBubble, PlayerBubble, ResultBadge, RollBadge } from './Bubbles.tsx';
import { changeBadges, dividerText, entryLook, shownVote } from './chat-model.ts';

const t = playText;

/** What the feed needs to put votes under AI text; leave it out and no entry gets buttons (the Human GM, a spectator). */
export interface FeedVoting {
  local: ReadonlyMap<number, EntryVote | null>;
  busy: ReadonlySet<number>;
  onVote: (entry: RoomEntry, next: EntryVote | null) => void;
}

export interface ChatFeedProps {
  entries: readonly RoomEntry[];
  /** Today's day and where we are (the divider names the day only when it differs; the arrival line goes at the last move). */
  day?: number | undefined;
  placeId: string | null;
  placeName?: string | undefined;
  /** An Astral Spirit reads every place and picks one (Q-192). */
  astral: boolean;
  acknowledged?: ReadonlySet<number>;
  /** Our own action of this turn (`RoomState.you.action`), drawn last on the right. */
  ownAction?: RoomState['you']['action'];
  voting?: FeedVoting | undefined;
}

/**
 * The chat feed (GEN-122): the room's entries as left / right messages. Our own action is on the right in an
 * amber box, an NPC's line on the left with avatar and name, GM narration and NPC reactions are italic text with
 * no box, rolls and changed values are capsules in the centre, a divider opens each turn / place.
 */
export function ChatFeed({ entries, day, placeId, placeName, astral, acknowledged, ownAction, voting }: ChatFeedProps) {
  const [only, setOnly] = useState('');
  const selectId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  // GEN-116: an NPC line can arrive later (a later seq) than the next turn's first entry; it belongs under its own turn.
  entries = [...entries].sort((a, b) => a.day - b.day || PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.turn - b.turn || a.seq - b.seq);
  const places = [...new Map(entries.flatMap((e) => (e.place ? [[e.place.id, e.place.name] as const] : []))).entries()];
  const shown = astral && only ? entries.filter((e) => e.place === null || e.place.id === only) : entries;
  const arrivedAfter = astral || !placeId || !placeName ? undefined : [...entries].reverse().find((e) => e.place && e.place.id !== placeId)?.seq;
  const last = `${entries.length}/${Math.max(0, ...entries.map((e) => e.seq))}/${ownAction?.text ?? ''}`;
  const atBottom = useRef(true);
  // New messages: follow them only while the reader is at the bottom; someone reading older ones is not moved.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last]);

  const vote = (entry: RoomEntry) => {
    if (!voting || entry.myVote === undefined) return null;
    return <VoteButtons value={shownVote(entry, voting.local) ?? null} disabled={voting.busy.has(entry.seq)} onVote={(next) => voting.onVote(entry, next)} />;
  };

  let before = '';
  const rows: ReactNode[] = [];
  for (const e of shown) {
    const look = entryLook(e, acknowledged?.has(e.seq));
    if (look === 'skip') continue;
    const where = `${e.day}|${e.phase}|${e.turn}|${e.place?.id ?? ''}`;
    if (where !== before) {
      before = where;
      rows.push(
        <li key={`d${e.seq}`} className="chat-item">
          <FeedDivider text={dividerText(e, day)} />
        </li>,
      );
    }
    rows.push(
      <Fragment key={e.seq}>
        <li className="chat-item">{entryView(e, look, vote, placeId, astral)}</li>
        {e.seq === arrivedAfter && placeName && (
          <li className="chat-item chat-item--arrival">
            <FeedDivider text={`— ${t.feed.arrived(placeName)} —`} />
          </li>
        )}
      </Fragment>,
    );
  }

  return (
    <section className="chat-feed" aria-label={t.feed.label}>
      {astral && (
        <div className="chat-astral">
          <span className="chip">{t.feed.readOnly}</span>
          <label htmlFor={selectId}>{t.feed.pickPlace}</label>
          <select id={selectId} value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">{t.feed.allPlaces}</option>
            {places.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div
        className="chat-scroll"
        ref={scroller}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {rows.length === 0 && !ownAction ? (
          <p className="muted chat-empty">{t.feed.empty}</p>
        ) : (
          <ol className="chat-list">
            {rows}
            {ownAction && (
              <li className="chat-item">
                <OwnBubble text={ownAction.text} secret={ownAction.visibility === 'secret'} />
              </li>
            )}
          </ol>
        )}
      </div>
    </section>
  );
}

function entryView(e: RoomEntry, look: ReturnType<typeof entryLook>, vote: (entry: RoomEntry) => ReactNode, placeId: string | null, astral: boolean): ReactNode {
  // Something said or seen at another place (or by the whole town): a word says where, not only the divider.
  const tag = e.kind === 'omen' ? t.chat.omen : !e.place && e.kind === 'feed' ? t.feed.town : e.place && e.place.id !== placeId && astral ? t.feed.at(e.place.name) : undefined;
  const fallback = e.fallback ? <small className="fallback-label">{FALLBACK_NARRATION_LABEL}</small> : null;
  switch (look) {
    case 'narration':
    case 'omen':
      return (
        <>
          <NarrationLine text={e.text} tag={tag}>
            {fallback}
            {vote(e)}
          </NarrationLine>
          {e.roll && <RollBadge roll={e.roll} />}
        </>
      );
    case 'npc-dialogue':
      return (
        <NpcBubble name={e.npc!.name} grade={e.npc!.grade} text={e.text} privateLine={e.npc!.private === true}>
          {vote(e)}
        </NpcBubble>
      );
    case 'player-action':
      return <PlayerBubble alias={e.actor!.name} text={e.text} />;
    case 'npc-reaction':
      return (
        <NarrationLine text={e.text}>
          {vote(e)}
        </NarrationLine>
      );
    case 'changes': {
      const badges = changeBadges(e.changes ?? []);
      return badges.length === 0 ? null : (
        <ul className="chat-center" aria-label={t.changes.label}>
          {badges.map((b, i) => (
            <li key={i}>
              <ResultBadge tone={b.tone}>{b.text}</ResultBadge>
            </li>
          ))}
        </ul>
      );
    }
    case 'hit-line':
      return (
        <div className="chat-center">
          <ResultBadge tone="hit">{[t.chat.hit, e.text, ...(e.hit?.changes.map(hitChangeText) ?? [])].join(' · ')}</ResultBadge>
        </div>
      );
    case 'skip':
      return null;
  }
}
