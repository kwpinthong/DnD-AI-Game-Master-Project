import { uiText } from './strings.ts';

/**
 * The step bar of a flow with a fixed order (GEN-090: character creation). It says the place in words
 * ("ขั้นที่ 2 / 3"), marks the current step with aria-current, and a step that can be opened is a button.
 * Done / current / to do differ by mark shape and by words, not by colour alone.
 */
export function Stepper({
  label,
  steps,
  current,
  canOpen,
  onOpen,
}: {
  /** Names the navigation, e.g. "ขั้นตอนสร้างตัวละคร". */
  label: string;
  steps: readonly string[];
  /** Index of the step shown now. */
  current: number;
  /** Whether another step may be opened from here (earlier steps, or later ones already filled in). */
  canOpen: (index: number) => boolean;
  onOpen: (index: number) => void;
}) {
  return (
    <nav className="stepper" aria-label={label}>
      <p className="stepper__count">{uiText.stepper.count(current + 1, steps.length)}</p>
      <ol className="stepper__steps">
        {steps.map((name, index) => {
          const state = index === current ? 'current' : index < current ? 'done' : 'todo';
          const text = (
            <>
              <span className="stepper__mark" aria-hidden="true">
                {uiText.stepper.mark[state]}
              </span>
              <span className="stepper__name">{name}</span>
              {state === 'done' && <span className="sr-only"> {uiText.stepper.done}</span>}
            </>
          );
          return (
            <li key={name} className={`stepper__step stepper__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              {state !== 'current' && canOpen(index) ? (
                <button type="button" className="stepper__open" onClick={() => onOpen(index)}>
                  {text}
                </button>
              ) : (
                <span className="stepper__label">{text}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
