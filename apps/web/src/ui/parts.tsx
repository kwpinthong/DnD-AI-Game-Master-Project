import { useId, type ReactNode } from 'react';
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
