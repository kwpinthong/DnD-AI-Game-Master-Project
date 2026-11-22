import type { EntryVote } from '@isekai/protocol';
import { voteText } from './strings.ts';

export interface VoteButtonsProps {
  /** The player's current vote (`RoomEntry.myVote`); null = none. */
  value: EntryVote | null;
  /** The vote to store: the pressed one, the other one when changing, or null when the pressed one is pressed again. */
  onVote: (next: EntryVote | null) => void;
  /** A request is running. */
  disabled?: boolean;
}

/**
 * ถูกใจ / ไม่ถูกใจ under a message the AI GM wrote (GEN-107). Render it only for a player and only when the
 * entry has `myVote` (the server leaves it out for the Human GM and for text that is not the AI's).
 */
export function VoteButtons({ value, onVote, disabled = false }: VoteButtonsProps) {
  const button = (vote: EntryVote) => (
    <button
      type="button"
      className={`vote-btn vote-btn--${vote}`}
      aria-pressed={value === vote}
      disabled={disabled}
      onClick={() => onVote(value === vote ? null : vote)}
    >
      <span aria-hidden="true">{voteText[vote].icon}</span> {voteText[vote].label}
    </button>
  );
  return (
    <div className="vote-buttons" role="group" aria-label={voteText.group}>
      {button('up')}
      {button('down')}
    </div>
  );
}
