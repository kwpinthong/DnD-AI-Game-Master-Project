import type { NpcDialogueLevel } from '@isekai/protocol';
import { npcDialogueText } from './ui/strings.ts';
import './pregame.css';

/** GEN-127: น้อย / ปกติ / เยอะ with a line each; used by the create form (ISK-019: the lobby only shows the level). */
export function NpcDialoguePicker({
  value,
  onChange,
}: {
  value: NpcDialogueLevel;
  onChange: (level: NpcDialogueLevel) => void;
}) {
  return (
    <fieldset className="pregame__group" role="radiogroup" aria-label={npcDialogueText.group}>
      <legend>{npcDialogueText.group}</legend>
      {npcDialogueText.levels.map((level) => (
        <label className="check" key={level.value}>
          <input type="radio" name="npcDialogue" checked={value === level.value} onChange={() => onChange(level.value)} />
          <span>
            {level.label} <small className="pregame__note">{level.hint}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
