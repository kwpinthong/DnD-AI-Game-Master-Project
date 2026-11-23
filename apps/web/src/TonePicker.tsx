import type { GameTone } from '@isekai/protocol';
import { toneText } from './ui/strings.ts';
import './pregame.css';

/** GEN-177: tone A / B / C with a line each, like NpcDialoguePicker; `value` undefined = none picked (server default). */
export function TonePicker({
  value,
  onChange,
  disabled = false,
  note,
}: {
  value: GameTone | undefined;
  onChange: (tone: GameTone) => void;
  disabled?: boolean;
  note?: string | undefined;
}) {
  return (
    <fieldset className="pregame__group" role="radiogroup" aria-label={toneText.group}>
      <legend>{toneText.group}</legend>
      {toneText.tones.map((tone) => (
        <label className="check" key={tone.value}>
          <input type="radio" name="tone" checked={value === tone.value} disabled={disabled} onChange={() => onChange(tone.value)} />
          <span>
            {tone.label} <small className="pregame__note">{tone.hint}</small>
          </span>
        </label>
      ))}
      {note && <p className="pregame__note">{note}</p>}
    </fieldset>
  );
}
