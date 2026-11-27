import type { NpcLineView, RollView } from '@isekai/protocol';
import { useState, type ReactNode } from 'react';
import { playText } from '../../ui/strings.ts';
import { avatarArt, RING_ART, ringFor } from '../ring-art.ts';
import type { BadgeTone } from './chat-model.ts';
import { rollBadge } from './chat-model.ts';
import { splitBubbles } from './stream.ts';

/**
 * The pieces of one chat feed (GEN-122), all props and no state, so the phone layout (GEN-123) puts them in
 * its own frame. Who speaks is told by the side, the box and a word, never by colour alone.
 */

export type Grade = NonNullable<NpcLineView['grade']>;

/**
 * A round avatar with the painted ring of its kind (GEN-132): the NPC's grade when the payload gave it, our own character =
 * player, anyone else (another player, a grade we are not told) = the neutral B ring. Inside: the preset picture of
 * `avatarId` (ISK-007), or the first letter when there is none (a character made before ISK-006) or it does not load.
 */
export function Avatar({ name, grade, size = 'md', own = false, slot, avatarId }: { name: string; grade?: Grade | undefined; size?: 'md' | 'lg'; own?: boolean; slot?: number | undefined; avatarId?: string | null | undefined }) {
  const ring = ringFor({ own, grade });
  const [broken, setBroken] = useState<string>();
  const art = broken === avatarId ? null : avatarArt(avatarId);
  return (
    <span className={`chat-avatar chat-avatar--${size} chat-avatar--${grade ? `g-${grade.toLowerCase()}` : 'plain'}${slot ? ` chat-avatar--npc-${slot}` : ''}`} data-ring={ring} aria-hidden="true">
      {art ? <img className="chat-avatar__face" src={art.src} srcSet={art.srcSet} alt="" onError={() => setBroken(avatarId ?? undefined)} /> : ([...name][0] ?? '?')}
      <img className="chat-avatar__ring" src={RING_ART[ring]} alt="" />
    </span>
  );
}

/** Our own action: amber box on the right with "คุณ" above; "ลับ" is a word badge, not only a colour. */
export function OwnBubble({ text, secret = false, self }: { text: string; secret?: boolean; /** ISK-007: our avatar beside the box (left out = none). */ self?: { name: string; avatarId: string | null } | undefined }) {
  return (
    <div className="chat-row chat-row--own">
      <div className="chat-col chat-col--own">
        <span className="chat-who">
          {playText.chat.you}
          {secret && <span className="chat-badge chat-badge--secret">{playText.chat.secret}</span>}
        </span>
        <p className="chat-box chat-box--own">{text}</p>
      </div>
      {self && <Avatar name={self.name} avatarId={self.avatarId} own />}
    </div>
  );
}

/**
 * What an NPC says: avatar + name + short boxes (GEN-148), on the left. `slot` = its colour (--npc-N) in this feed,
 * amber without one. `lines` = what is out so far while it streams. `children` = the vote buttons.
 */
export function NpcBubble({
  name,
  grade,
  text,
  slot,
  lines = splitBubbles(text),
  privateLine = false,
  children,
}: {
  name: string;
  grade?: Grade | undefined;
  text: string;
  slot?: number | undefined;
  lines?: readonly string[];
  privateLine?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="chat-row chat-row--left">
      <Avatar name={name} grade={grade} slot={slot} />
      <div className="chat-col">
        <span className={`chat-who chat-who--npc${slot ? ` chat-npc-${slot}` : ''}`}>
          {name}
          {privateLine && <span className="chat-badge chat-badge--private">{playText.chat.privateLine}</span>}
        </span>
        {lines.map((line, i) => (
          <p key={i} className="chat-box chat-box--npc">
            {line}
          </p>
        ))}
        {children}
      </div>
    </div>
  );
}

/** "กำลังพิมพ์…": at the NPC's avatar once its line is here, or a plain one while the dialogue stage may still write. */
export function TypingBubble({ name, grade, slot }: { name?: string | undefined; grade?: Grade | undefined; slot?: number | undefined }) {
  const label = name ? `${name} ${playText.chat.typing}` : playText.chat.typing;
  return (
    <div className="chat-row chat-row--left" role="status" aria-label={label}>
      <Avatar name={name ?? '…'} grade={grade} slot={slot} />
      <div className="chat-col">
        {name && <span className={`chat-who chat-who--npc${slot ? ` chat-npc-${slot}` : ''}`}>{name}</span>}
        <p className="chat-box chat-box--npc chat-typing">
          {playText.chat.typing}
          <span className="chat-typing__dots" aria-hidden="true">
            <span className="chat-typing__dot" />
            <span className="chat-typing__dot" />
            <span className="chat-typing__dot" />
          </span>
        </p>
      </div>
    </div>
  );
}

/** What another player did: avatar + their alias (never the name, GEN-117) + box, on the left. */
export function PlayerBubble({ alias, text, avatarId }: { alias: string; text: string; avatarId?: string | null | undefined }) {
  return (
    <div className="chat-row chat-row--left">
      <Avatar name={alias} avatarId={avatarId} />
      <div className="chat-col">
        <span className="chat-who chat-who--player">{alias}</span>
        <p className="chat-box chat-box--player">{text}</p>
      </div>
    </div>
  );
}

/** GM narration and NPC reactions: italic, no box, no avatar, indented. */
export function NarrationLine({ text, tag, children }: { text: string; tag?: string | undefined; children?: ReactNode }) {
  return (
    <div className="chat-narration">
      {tag && <span className="chat-tag">{tag}</span>}
      <p className="chat-narration__text">{text}</p>
      {children}
    </div>
  );
}

/** A small capsule in the centre: a roll, a changed value. */
export function ResultBadge({ tone = 'plain', children }: { tone?: BadgeTone | 'hit'; children: ReactNode }) {
  return <span className={`chat-result chat-result--${tone}`}>{children}</span>;
}

/** The roll of our own action: the capsule, and why in a fold (words only). */
export function RollBadge({ roll }: { roll: RollView }) {
  return (
    <div className="chat-center">
      <ResultBadge>{rollBadge(roll)}</ResultBadge>
      {roll.factors.length > 0 && (
        <details className="chat-why">
          <summary>{playText.private.why}</summary>
          <ul aria-label={playText.private.factors}>
            {roll.factors.map((f, i) => (
              <li key={i}>{`${playText.private.dir[f.dir]} ${f.label}`}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** "— บ่าย · เทิร์น 1 · น้ำพุกลางเมือง —" */
export function FeedDivider({ text }: { text: string }) {
  return <div className="chat-divider">{text}</div>;
}
