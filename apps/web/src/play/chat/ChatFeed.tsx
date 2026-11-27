import { FALLBACK_NARRATION_LABEL, PHASES, type EntryVote, type RoomEntry, type RoomState, type VoteReason } from '@isekai/protocol';
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { hitChangeText } from '../../screen-models.ts';
import { VoteButtons, playText } from '../../ui/index.ts';
import { FeedDivider, NarrationLine, NpcBubble, OwnBubble, PlayerBubble, ResultBadge, RollBadge, TypingBubble } from './Bubbles.tsx';
import { changeBadges, dividerText, entryLook, shownVote } from './chat-model.ts';
import { awaitingDialogue, npcSlots, revealBubbles, revealPhase, revealPlan, revealShare, splitBubbles, useReducedMotion, type Reveal, type RevealPhase } from './stream.ts';

const t = playText;

/** What the feed needs to put votes under AI text; leave it out and no entry gets buttons (the Human GM, a spectator). */
export interface FeedVoting {
  local: ReadonlyMap<number, EntryVote | null>;
  busy: ReadonlySet<number>;
  onVote: (entry: RoomEntry, next: EntryVote | null) => void;
  /** GEN-168: the 👎 reasons changed this session (the entry's `myReasons` is the base); leave out = no chips. */
  reasons?: ReadonlyMap<number, readonly VoteReason[]>;
  onReasons?: (entry: RoomEntry, next: VoteReason[]) => void;
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
  /** ISK-007: our character, for the avatar beside our own action. */
  self?: { name: string; avatarId: string | null } | undefined;
  voting?: FeedVoting | undefined;
  /** GEN-148: seq → when it arrived (ms) of the entries that came in while online; only those are revealed piece by piece. */
  live?: ReadonlyMap<number, number> | undefined;
}

const NO_LIVE: ReadonlyMap<number, number> = new Map();
/** The looks that stream in (GEN-148); badges, dividers and our own words appear at once. */
const STREAMED = new Set<ReturnType<typeof entryLook>>(['narration', 'omen', 'npc-dialogue', 'npc-reaction']);

interface Shown {
  phase: RevealPhase;
  share: number;
  slot: number | undefined;
}

/**
 * The chat feed (GEN-122): the room's entries as left / right messages. Our own action is on the right in an
 * amber box, an NPC's line on the left with avatar and name, GM narration and NPC reactions are italic text with
 * no box, rolls and changed values are capsules in the centre, a divider opens each turn / place.
 */
export function ChatFeed({ entries, day, placeId, placeName, astral, acknowledged, ownAction, self, voting, live = NO_LIVE }: ChatFeedProps) {
  const [only, setOnly] = useState('');
  const selectId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [now, setNow] = useState(Date.now);
  // GEN-116: an NPC line can arrive later (a later seq) than the next turn's first entry; it belongs under its own turn.
  entries = [...entries].sort((a, b) => a.day - b.day || PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.turn - b.turn || a.seq - b.seq);
  const places = [...new Map(entries.flatMap((e) => (e.place ? [[e.place.id, e.place.name] as const] : []))).entries()];
  const shown = astral && only ? entries.filter((e) => e.place === null || e.place.id === only) : entries;
  const arrivedAfter = astral || !placeId || !placeName ? undefined : [...entries].reverse().find((e) => e.place && e.place.id !== placeId)?.seq;
  const slots = npcSlots(entries);
  const plan = reduced
    ? new Map<number, Reveal>()
    : revealPlan(shown.flatMap((e) => (live.has(e.seq) && STREAMED.has(entryLook(e)) ? [{ seq: e.seq, at: live.get(e.seq)!, text: e.text, typing: entryLook(e) === 'npc-dialogue' }] : [])));
  const streaming = [...plan.values()].some((r) => now < r.to);
  const waiting = awaitingDialogue(entries, live, now) && !streaming;
  const last = `${entries.length}/${Math.max(0, ...entries.map((e) => e.seq))}/${ownAction?.text ?? ''}/${streaming ? now : ''}/${waiting}`;
  // Ticks only while something streams or waits; a quiet feed has no timer.
  useEffect(() => {
    if (!streaming && !waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 40);
    return () => clearInterval(timer);
  }, [streaming, waiting]);
  const atBottom = useRef(true);
  // New messages: follow them only while the reader is at the bottom; someone reading older ones is not moved.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last]);

  const vote = (entry: RoomEntry) => {
    if (!voting || entry.myVote === undefined) return null;
    const onReasons = voting.onReasons;
    return (
      <VoteButtons
        value={shownVote(entry, voting.local) ?? null}
        disabled={voting.busy.has(entry.seq)}
        onVote={(next) => voting.onVote(entry, next)}
        reasons={voting.reasons?.get(entry.seq) ?? entry.myReasons ?? []}
        {...(onReasons ? { onReasons: (next: VoteReason[]) => onReasons(entry, next) } : {})}
      />
    );
  };

  let before = '';
  const rows: ReactNode[] = [];
  for (const e of shown) {
    const look = entryLook(e, acknowledged?.has(e.seq));
    if (look === 'skip') continue;
    const reveal = plan.get(e.seq);
    const view: Shown = { phase: revealPhase(reveal, now), share: revealShare(reveal, now), slot: e.npc ? slots.get(e.npc.ref) : undefined };
    if (view.phase === 'queued') continue;
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
        <li className="chat-item" aria-busy={view.phase !== 'done' || undefined}>
          {entryView(e, look, view.phase === 'done' ? vote : () => null, placeId, astral, view)}
        </li>
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
            {waiting && (
              <li className="chat-item">
                <TypingBubble />
              </li>
            )}
            {ownAction && (
              <li className="chat-item">
                <OwnBubble text={ownAction.text} secret={ownAction.visibility === 'secret'} self={self} />
              </li>
            )}
          </ol>
        )}
      </div>
    </section>
  );
}

function entryView(e: RoomEntry, look: ReturnType<typeof entryLook>, vote: (entry: RoomEntry) => ReactNode, placeId: string | null, astral: boolean, view: Shown): ReactNode {
  // Something said or seen at another place (or by the whole town): a word says where, not only the divider.
  const tag = e.kind === 'omen' ? t.chat.omen : !e.place && e.kind === 'feed' ? t.feed.town : e.place && e.place.id !== placeId && astral ? t.feed.at(e.place.name) : undefined;
  const done = view.phase === 'done';
  const fallback = e.fallback && done ? <small className="fallback-label">{FALLBACK_NARRATION_LABEL}</small> : null;
  // GEN-148: only a prefix of the final (already masked) text is ever drawn.
  const text = done ? e.text : (revealBubbles([e.text], view.share)[0] ?? '');
  switch (look) {
    case 'narration':
    case 'omen':
      return (
        <>
          <NarrationLine text={text} tag={tag}>
            {fallback}
            {vote(e)}
          </NarrationLine>
          {e.roll && done && <RollBadge roll={e.roll} />}
        </>
      );
    case 'npc-dialogue':
      if (view.phase === 'typing') return <TypingBubble name={e.npc!.name} grade={e.npc!.grade} slot={view.slot} />;
      return (
        <NpcBubble
          name={e.npc!.name}
          grade={e.npc!.grade}
          text={e.text}
          slot={view.slot}
          {...(done ? {} : { lines: revealBubbles(splitBubbles(e.text), view.share) })}
          privateLine={e.npc!.private === true}
        >
          {vote(e)}
        </NpcBubble>
      );
    case 'player-action':
      return <PlayerBubble alias={e.actor!.name} text={e.text} avatarId={e.actor!.avatarId} />;
    case 'npc-reaction':
      return (
        <NarrationLine text={text}>
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
    case 'time':
      // GEN-145: the server's announcement of a new period, a centred line (no box, no votes).
      return <p className="chat-time">{e.text}</p>;
    case 'news':
      // ISK-014: the morning news, one line per item, for everyone alike (no votes).
      return (
        <section className="chat-news" aria-label={t.chat.news(e.day)}>
          <p className="chat-news-title">
            <ScrollIcon />
            {t.chat.news(e.day)}
          </p>
          <ul>
            {e.text.split('\n').map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      );
    case 'skip':
      return null;
  }
}

/** A rolled scroll in the text colour (decoration only; the title says "ข่าวเช้า"). */
function ScrollIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4h11a2 2 0 0 1 2 2v1h-4" />
      <path d="M16 7v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1h10" />
      <path d="M7 4a2 2 0 0 0-2 2v11" />
      <path d="M9 9h4M9 12h4" />
    </svg>
  );
}
