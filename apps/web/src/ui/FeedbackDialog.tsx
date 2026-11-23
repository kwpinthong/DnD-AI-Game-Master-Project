import { FEEDBACK_TEXT_MAX, FEEDBACK_TYPES, type FeedbackPage, type FeedbackType } from '@isekai/protocol';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { postFeedback, type FeedbackResult } from '../feedback-api.ts';
import { Button } from './Button.tsx';
import { Toast } from './parts.tsx';
import { feedbackText as t } from './strings.ts';
import './confirm-dialog.css';
import './feedback.css';

const codePoints = (s: string) => [...s].length;

const PROBLEM: Record<Exclude<FeedbackResult['kind'], 'ok'>, string> = {
  rate_limited: t.rateLimited,
  session_lost: t.sessionLost,
  unreachable: t.unreachable,
  failed: t.failed,
};

/**
 * ISK-011: the report box. It stays mounted while closed, so a draft that was not sent is still there when
 * the box opens again (until it is sent or the page goes away). Counts code points like the server (ISK-010).
 */
export function FeedbackDialog({
  apiBaseUrl,
  token,
  page,
  open,
  onClose,
  initialText = '',
}: {
  apiBaseUrl: string;
  token: string;
  page: FeedbackPage;
  open: boolean;
  onClose: () => void;
  /** The gallery opens it with a draft already typed. */
  initialText?: string;
}) {
  const titleId = useId();
  const countId = useId();
  const [type, setType] = useState<FeedbackType>('bug');
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [thanks, setThanks] = useState(false);
  // State lags a fast second press: the ref stops a second request before the re-render.
  const inFlight = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setThanks(false);
    box.current?.focus();
  }, [open]);

  if (!open) {
    return thanks ? (
      <div className="feedback-thanks">
        <Toast tone="success" onClose={() => setThanks(false)}>
          {t.thanks}
        </Toast>
      </div>
    ) : null;
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || text.trim() === '') return;
    inFlight.current = true;
    setSending(true);
    setProblem(undefined);
    const result = await postFeedback(apiBaseUrl, token, { type, text, page, userAgent: navigator.userAgent });
    inFlight.current = false;
    setSending(false);
    if (result.kind !== 'ok') return setProblem(PROBLEM[result.kind]);
    setText('');
    setType('bug');
    setThanks(true);
    onClose();
  }

  return (
    <div className="dialog-backdrop feedback-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="feedback-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !sending) onClose();
        }}
      >
        <h3 id={titleId} className="feedback-dialog__title">
          {t.open}
        </h3>
        <form onSubmit={(e) => void send(e)} noValidate>
          <fieldset className="feedback-type">
            <legend>{t.typeLegend}</legend>
            {FEEDBACK_TYPES.map((value) => (
              <label key={value}>
                <input type="radio" name={`${titleId}-type`} value={value} checked={type === value} onChange={() => setType(value)} />
                {t.type[value]}
              </label>
            ))}
          </fieldset>
          <label className="feedback-dialog__field">
            {t.text}
            <textarea
              ref={box}
              rows={6}
              value={text}
              aria-describedby={countId}
              onChange={(e) => {
                const next = e.target.value;
                setText(codePoints(next) > FEEDBACK_TEXT_MAX ? [...next].slice(0, FEEDBACK_TEXT_MAX).join('') : next);
              }}
            />
          </label>
          <small id={countId} className="feedback-dialog__count">
            {t.count(codePoints(text), FEEDBACK_TEXT_MAX)}
          </small>
          {sending && <p role="status">{t.sending}</p>}
          {problem && <p role="alert">{problem}</p>}
          <div className="dialog__actions">
            <Button onClick={onClose} disabled={sending}>
              {t.close}
            </Button>
            <Button type="submit" variant="primary" disabled={sending || text.trim() === ''} aria-busy={sending || undefined}>
              {t.send}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The corner button for pages with no menu of their own (Lobby, character, loot, spawn, the end page). */
export function FeedbackButton({ apiBaseUrl, token, page }: { apiBaseUrl: string; token: string; page: FeedbackPage }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn--secondary feedback-corner" aria-label={t.open} title={t.open} onClick={() => setOpen(true)}>
        <span aria-hidden="true">⚑</span>
      </button>
      <FeedbackDialog apiBaseUrl={apiBaseUrl} token={token} page={page} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
