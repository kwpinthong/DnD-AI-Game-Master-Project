import { useId, type CSSProperties, type ReactNode } from 'react';
import hitIcon from '../assets/icons/status-hit.svg';
import publicIcon from '../assets/icons/visibility-public.svg';
import secretIcon from '../assets/icons/visibility-secret.svg';
import { Button } from './Button.tsx';
import { MaskIcon } from './MaskIcon.tsx';
import { uiText } from './strings.ts';

export type Visibility = 'public' | 'secret';

/** เปิดเผย / ลับ: word + icon + colour, never colour alone (ADR UI Direction). */
export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  const text = uiText.visibility[visibility];
  return (
    <span className={`badge badge--${visibility}`} title={text.tooltip}>
      <MaskIcon src={visibility === 'secret' ? secretIcon : publicIcon} />
      {text.label}
    </span>
  );
}

/** A panel (แผง) with the thin gold L corners; `private` = the ink-purple column only you see. */
export function Panel({
  title,
  audience = 'public',
  ornament = true,
  className,
  children,
}: {
  title: string;
  audience?: 'public' | 'private';
  ornament?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = ['panel', audience === 'private' && 'panel--private', ornament && 'panel--ornament', className];
  return (
    <section className={classes.filter(Boolean).join(' ')} aria-label={title}>
      {children}
    </section>
  );
}

/** The "เกิดกับคุณ" card: what another player did to you, pinned until acknowledged. */
export function HitCard({ actor, onAcknowledge, children }: { actor: string | null; onAcknowledge?: () => void; children: ReactNode }) {
  const titleId = useId();
  return (
    <article className="hit-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="hit-card__title">
        <MaskIcon src={hitIcon} />
        {uiText.hit.title}
      </h3>
      <p className="hit-card__body">{children}</p>
      <p className="hit-card__actor">{actor ?? uiText.hit.unknownActor}</p>
      {onAcknowledge && <Button onClick={onAcknowledge}>{uiText.hit.acknowledge}</Button>}
    </article>
  );
}

/**
 * A thin bar for an own value with a maximum (HP, Stamina). Decoration next to the number and the word:
 * `label` is what a screen reader hears. `tone`: `low` = running out, `spent` = none left.
 */
export function Meter({ label, value, max, tone = 'ok' }: { label: string; value: number; max: number; tone?: 'ok' | 'low' | 'spent' }) {
  const share = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const style = { '--fill': `${Math.round(share * 100)}%` } as CSSProperties;
  return (
    <span className={`meter meter--${tone}`} role="img" aria-label={label}>
      <span className="meter__fill" style={style} />
    </span>
  );
}

/** A bar of steps (the 6-step companion bond, F4): a filled cell is solid, an open one is an outline. */
export function StepBar({ label, cells }: { label: string; cells: readonly boolean[] }) {
  return (
    <span className="step-bar" role="img" aria-label={label}>
      {cells.map((on, i) => (
        <span key={i} className={on ? 'step-bar__cell step-bar__cell--on' : 'step-bar__cell'} />
      ))}
    </span>
  );
}

/** A short notice; success / danger begin with a word so the tone is not colour alone. */
export function Toast({ tone = 'info', onClose, children }: { tone?: 'info' | 'success' | 'danger'; onClose?: () => void; children: ReactNode }) {
  const prefix = uiText.toast[tone];
  return (
    <div className={`toast toast--${tone}`} role="status" aria-live="polite">
      <p className="toast__text">
        {prefix && <strong>{prefix} </strong>}
        {children}
      </p>
      {onClose && (
        <button type="button" className="btn btn--secondary toast__close" onClick={onClose}>
          {uiText.toast.close}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="state state--empty">
      <h3 className="state__title">{title}</h3>
      {children && <p className="state__text">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <h3 className="state__title">{uiText.error.title}</h3>
      <p className="state__text">{message}</p>
      {onRetry && <Button onClick={onRetry}>{uiText.error.retry}</Button>}
    </div>
  );
}

/** Placeholder lines while data loads; readers hear the label, the bars are decoration. */
export function Skeleton({ lines = 3, label = uiText.skeleton }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton__line" aria-hidden="true" />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
