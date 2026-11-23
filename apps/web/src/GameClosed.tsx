import { useEffect, useId, useRef } from 'react';
import { Button } from './ui/Button.tsx';
import { gameClosedText as t } from './ui/strings.ts';
import './ui/confirm-dialog.css';

export interface GameClosure {
  reason: string | null;
  hasSummary: boolean;
}

/**
 * ISK-002: the server owner closed this game. Nothing is left to do in it, so the modal has no way out but its
 * one button: the end page when the game was played (`hasSummary`), else home.
 */
export function GameClosedModal({ closed, onSummary, onHome }: { closed: GameClosure; onSummary: () => void; onHome: () => void }) {
  const id = useId();
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => actions.current?.querySelector('button')?.focus(), []);
  return (
    <div className="dialog-backdrop">
      <div role="alertdialog" aria-modal="true" aria-labelledby={`${id}title`} className="dialog">
        <h3 id={`${id}title`} className="dialog__title">
          {t.title}
        </h3>
        {closed.reason && <p className="dialog__text">{t.reason(closed.reason)}</p>}
        <div className="dialog__actions" ref={actions}>
          {closed.hasSummary ? (
            <Button variant="primary" onClick={onSummary}>
              {t.toSummary}
            </Button>
          ) : (
            <Button variant="primary" onClick={onHome}>
              {t.home}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
