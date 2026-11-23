import { ACTION_MAX_LENGTH, type ActionVisibility, type PlaceActionId, type RoomState } from '@isekai/protocol';
import { useId, useRef, useState, type FormEvent } from 'react';
import attackIcon from '../../assets/icons/action-attack.svg';
import defendIcon from '../../assets/icons/action-defend.svg';
import investigateIcon from '../../assets/icons/action-investigate.svg';
import observeIcon from '../../assets/icons/action-observe.svg';
import persuadeIcon from '../../assets/icons/action-persuade.svg';
import prayIcon from '../../assets/icons/action-pray.svg';
import restIcon from '../../assets/icons/action-rest.svg';
import stealthIcon from '../../assets/icons/action-stealth.svg';
import { lockDetail, lockTitle, secretQuota, sentHow } from '../../screen-models.ts';
import { Button, MaskIcon, playText, uiText } from '../../ui/index.ts';
import { QUICK_WORDS, prefillAction, type QuickWord } from './chat-model.ts';

const t = playText;
const bar = t.chat.bar;
const VISIBILITY_LABEL = { public: uiText.visibility.public.label, secret: uiText.visibility.secret.label } as const;

/** What the player is composing for this turn. `editing`: changing an action that is already sent. */
export interface ActionDraft {
  text: string;
  visibility: ActionVisibility;
  rest: boolean;
  train: boolean;
  placeAction: PlaceActionId | null;
  editing: boolean;
}
export const EMPTY_DRAFT: ActionDraft = { text: '', visibility: 'public', rest: false, train: false, placeAction: null, editing: false };

const QUICK_ICON: Record<QuickWord, string> = { พูดคุย: persuadeIcon, สังเกต: observeIcon, สืบค้น: investigateIcon, โจมตี: attackIcon, ป้องกัน: defendIcon, สวด: prayIcon, ลอบเร้น: stealthIcon, พัก: restIcon };

/** The AI GM could not finish the turn: why, and [ลองใหม่] when it helps. */
export function GmStatus({ room, onRetry }: { room: RoomState; onRetry: () => void }) {
  if (!room.gmStatus) return null;
  return (
    <div className="play-gm-status">
      <p role="alert">{room.gmStatus.message}</p>
      {room.gmStatus.canRetry && <Button onClick={onRetry}>{t.retry}</Button>}
    </div>
  );
}

export interface ActionBarProps {
  room: RoomState;
  /** People + NPCs at your place who would see a public action; null = not known yet. */
  seenBy: number | null;
  draft: ActionDraft;
  setDraft: (next: ActionDraft) => void;
  problem: string | undefined;
  sending: boolean;
  onSend: (draft: ActionDraft) => void;
  onRetry: () => void;
  /** The phone (GEN-123): icon buttons and [อื่นๆ] instead of the row of words. */
  compact?: boolean;
}

/**
 * The bottom bar of the chat Play page (GEN-122): eight quick words that only prefill the box, [ลับ], the
 * rounded box and [ส่ง]. Nothing is sent until [ส่ง]. When it cannot be used it says why in words (a lock, a sent
 * action waiting for the turn, the AI GM stuck).
 */
export function ActionBar({ room, seenBy, draft, setDraft, problem, sending, onSend, onRetry, compact }: ActionBarProps) {
  const { you } = room;
  const [more, setMore] = useState(false);
  const textId = useId();
  const input = useRef<HTMLInputElement>(null);
  const quota = secretQuota(room);
  const lock = you.lock;
  const sent = you.action;
  const waiting = Boolean(sent) && !draft.editing && !lock;
  const off = Boolean(lock) || waiting;
  const visibility: ActionVisibility = draft.visibility === 'secret' && you.secretUsed ? 'public' : draft.visibility;
  const left = ACTION_MAX_LENGTH - [...draft.text].length;
  const chips = you.placeActions;

  function submit(event: FormEvent) {
    event.preventDefault();
    onSend({ ...draft, visibility });
  }

  // GEN-137 (Q-301 B): every word, พัก too, only fills the box; the server reads REST from the text (GEN-113).
  function quick(word: QuickWord) {
    setDraft({ ...draft, rest: false, train: false, placeAction: null, text: prefillAction(draft.text, word) });
    setMore(false);
    input.current?.focus();
  }

  function pickChip(id: PlaceActionId, label: string) {
    const on = draft.placeAction !== id;
    setDraft({ ...draft, placeAction: on ? id : null, rest: on && id !== 'train', train: on && id === 'train', text: on && draft.text.trim() === '' ? label : draft.text });
    setMore(false);
  }

  /** One of the eight words; `iconOnly` (the phone's row) leaves the word to the aria-label. */
  function wordButton(word: QuickWord, iconOnly: boolean) {
    return (
      <button
        key={word}
        type="button"
        className={iconOnly ? 'chat-quick__btn chat-quick__btn--icon' : 'chat-quick__btn'}
        disabled={off}
        aria-label={iconOnly ? bar.actions[word] : undefined}
        onClick={() => quick(word)}
      >
        <MaskIcon src={QUICK_ICON[word]} />
        {!iconOnly && bar.actions[word]}
      </button>
    );
  }

  // The server does not send the place's chips yet (GEN-069 pending): TRAIN stays reachable without them.
  const extraButtons = (
    <>
      {chips === undefined && (
        <button type="button" className="chat-quick__btn" disabled={off} aria-pressed={draft.train} onClick={() => setDraft({ ...draft, train: !draft.train, rest: false, placeAction: null })}>
          {t.action.train}
        </button>
      )}
      {chips?.map((chip) => (
        <button key={chip.id} type="button" className="chat-quick__btn" disabled={off || chip.blocked !== null} title={chip.blocked ?? undefined} aria-pressed={draft.placeAction === chip.id} onClick={() => pickChip(chip.id, chip.label)}>
          {chip.label}
        </button>
      ))}
    </>
  );

  return (
    <form className={visibility === 'secret' && !off ? 'chat-bar chat-bar--secret' : 'chat-bar'} onSubmit={submit} aria-label={t.action.form}>
      <GmStatus room={room} onRetry={onRetry} />
      {lock && (
        <div className="play-lock" role="note" aria-label={lockTitle(lock.code)}>
          <strong>{lockTitle(lock.code)}</strong>
          <p>{lock.message}</p>
          {lockDetail(room, lock.code) && <p className="muted">{lockDetail(room, lock.code)}</p>}
        </div>
      )}
      {sent && !draft.editing && !lock && (
        <div className="chat-bar__sent">
          <p>{t.action.sent(sentHow(sent, VISIBILITY_LABEL), sent.text)}</p>
          <p className="muted">{room.mode === 'single' ? t.action.waitResult : t.action.waitOthers(t.submitted(room.submittedCount, room.members.filter((m) => m.role === 'player').length))}</p>
          {room.status === 'collecting' && (
            <Button onClick={() => setDraft({ text: sent.text, visibility: sent.visibility, rest: sent.rest, train: Boolean(sent.train), placeAction: null, editing: true })}>{t.action.edit}</Button>
          )}
        </div>
      )}
      {compact ? (
        <>
          {/* Phone: the eight words as 44 x 44 icons (the word is the aria-label) and [อื่นๆ], which lists every action with words. */}
          <div className="chat-quick chat-quick--icons" role="group" aria-label={bar.group}>
            <div className="chat-quick__scroll">{QUICK_WORDS.map((word) => wordButton(word, true))}</div>
            <button type="button" className="chat-quick__more" aria-expanded={more} aria-haspopup="true" onClick={() => setMore(!more)}>
              {bar.more}
            </button>
          </div>
          {more && (
            <div className="chat-quick chat-quick--list" role="group" aria-label={bar.moreGroup}>
              {QUICK_WORDS.map((word) => wordButton(word, false))}
              {extraButtons}
            </div>
          )}
        </>
      ) : (
        <div className="chat-quick" role="group" aria-label={bar.group}>
          {QUICK_WORDS.map((word) => wordButton(word, false))}
          {extraButtons}
        </div>
      )}
      <div className="chat-compose">
        <label className="chat-secret">
          <input type="checkbox" checked={visibility === 'secret'} disabled={off || you.secretUsed} onChange={(e) => setDraft({ ...draft, visibility: e.target.checked ? 'secret' : 'public' })} />
          {bar.secret}
        </label>
        <label htmlFor={textId} className="sr-only">
          {bar.input}
        </label>
        <input
          ref={input}
          id={textId}
          type="text"
          className="chat-input"
          autoComplete="off"
          value={off ? '' : draft.text}
          disabled={off}
          placeholder={lock ? t.action.closed : waiting ? bar.waiting : bar.placeholder}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
        />
        <Button className="chat-send" variant="primary" type="submit" aria-label={sent ? bar.resend : bar.sendLabel} disabled={off} loading={sending} loadingText={t.action.sending}>
          {bar.send}
        </Button>
      </div>
      {!off && (
        <p className="chat-bar__hint">
          {left < 100 && <span>{t.action.left(left)} </span>}
          {quota.blocked && <span className="play-action__quota">{quota.blocked} </span>}
          <span>{visibility === 'secret' ? t.action.secretEffect : t.action.publicEffect(seenBy)}</span>
          {room.phase === 'NOCTHERION' && <span> {t.action.night}</span>}
        </p>
      )}
      {off && quota.blocked && <p className="chat-bar__hint">{quota.blocked}</p>}
      {you.drowsy && (
        <p className="chat-bar__hint" role="note">
          {t.action.drowsy}
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
    </form>
  );
}
