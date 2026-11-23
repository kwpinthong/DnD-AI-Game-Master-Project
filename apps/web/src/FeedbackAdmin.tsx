import { FEEDBACK_STATUSES, FEEDBACK_TYPES, type FeedbackRow, type FeedbackStatus, type FeedbackType } from '@isekai/protocol';
import { useEffect, useRef, useState } from 'react';
import { fetchFeedback, saveFeedbackStatus } from './admin-api.ts';
import { EmptyState, ErrorState, Skeleton } from './ui/parts.tsx';
import './ui/feedback.css';
import { feedbackText as t } from './ui/strings.ts';

/** Longer texts are cut to this many code points until the row is opened. */
const SHORT = 80;

const short = (text: string) => ([...text].length > SHORT ? `${[...text].slice(0, SHORT).join('')}…` : text);
const at = (r: FeedbackRow) =>
  r.context.day === null ? t.noTurn : `วัน ${r.context.day}${r.context.period ? ` · ${r.context.period}` : ''}${r.context.turn ? ` · เทิร์น ${r.context.turn}` : ''}`;

/**
 * ISK-011: the ฟีดแบ็ก tab of /admin. The players' reports (ISK-010), filtered by status and type, each with a
 * status the owner moves (new → reviewing → done). Texts are rendered as text, never as HTML.
 */
export function FeedbackAdmin({ apiBaseUrl, token, onForbidden }: { apiBaseUrl: string; token: string; onForbidden: (message: string) => void }) {
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<FeedbackStatus | ''>('');
  const [type, setType] = useState<FeedbackType | ''>('');
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const [problem, setProblem] = useState<string>();
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(undefined);
    void fetchFeedback(apiBaseUrl, token).then((r) => {
      if (!live) return;
      if (r.kind === 'forbidden') return onForbiddenRef.current(r.message);
      if (r.kind === 'error') return setError(r.message);
      setRows(r.data.feedback);
    });
    return () => {
      live = false;
    };
  }, [apiBaseUrl, token, attempt]);

  const put = (id: number, row: (r: FeedbackRow) => FeedbackRow) => setRows((list) => list && list.map((r) => (r.id === id ? row(r) : r)));

  async function change(row: FeedbackRow, next: FeedbackStatus) {
    setProblem(undefined);
    put(row.id, (r) => ({ ...r, status: next }));
    const result = await saveFeedbackStatus(apiBaseUrl, token, row.id, { status: next });
    if (result.kind === 'ok') return put(row.id, () => result.data);
    // not saved: back to what the server still has, unless a later change already moved the row on
    put(row.id, (r) => (r.status === next ? { ...r, status: row.status } : r));
    if (result.kind === 'forbidden') return onForbiddenRef.current(result.message);
    setProblem(t.saveFailed(result.message));
  }

  if (error) return <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (rows === null) return <Skeleton lines={4} label={t.loading} />;
  if (rows.length === 0) return <EmptyState title={t.empty}>{t.emptyText}</EmptyState>;

  // shortcut: filters the latest 200 the server sends on this page; use ?status= / ?type= when there are more.
  const shown = rows.filter((r) => (!status || r.status === status) && (!type || r.type === type));

  return (
    <div className="feedback-admin">
      <div className="admin__nav">
        <label>
          {t.filterStatus}
          <select aria-label={t.filterStatus} value={status} onChange={(e) => setStatus(e.target.value as FeedbackStatus | '')}>
            <option value="">{t.all}</option>
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.status[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.filterType}
          <select aria-label={t.filterType} value={type} onChange={(e) => setType(e.target.value as FeedbackType | '')}>
            <option value="">{t.all}</option>
            {FEEDBACK_TYPES.map((k) => (
              <option key={k} value={k}>
                {t.type[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {problem && <p role="alert">{problem}</p>}
      {shown.length === 0 ? (
        <p>{t.emptyFilter}</p>
      ) : (
        <table aria-label={t.table}>
          <thead>
            <tr>
              <th>{t.head.date}</th>
              <th>{t.head.type}</th>
              <th>{t.head.game}</th>
              <th>{t.head.at}</th>
              <th>{t.head.text}</th>
              <th>{t.head.status}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const isOpen = opened.has(r.id);
              return (
                <tr key={r.id}>
                  <td>{new Date(r.createdAt).toLocaleString('th-TH', { hour12: false })}</td>
                  <td>{t.type[r.type]}</td>
                  {/* shortcut: the game id, FeedbackRow has no game name; needs ISK-010 to send it (question to Nok). */}
                  <td>{r.gameId}</td>
                  <td>{at(r)}</td>
                  <td style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {short(r.text) === r.text ? (
                      r.text
                    ) : (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setOpened((set) => (isOpen ? new Set([...set].filter((id) => id !== r.id)) : new Set(set).add(r.id)))}
                      >
                        {isOpen ? r.text : short(r.text)}
                      </button>
                    )}
                  </td>
                  <td>
                    <select aria-label={t.statusOf(r.id)} value={r.status} onChange={(e) => void change(r, e.target.value as FeedbackStatus)}>
                      {FEEDBACK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t.status[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
