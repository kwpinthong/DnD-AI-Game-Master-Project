import { CLOSE_REASON_MAX, type AdminGameRow } from '@isekai/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { closeAdminGame, fetchAdminGames } from './admin-api.ts';
import { Button } from './ui/Button.tsx';
import { EmptyState, ErrorState, Skeleton } from './ui/parts.tsx';
import { adminGamesText as t } from './ui/strings.ts';
import './ui/confirm-dialog.css';
import './library.css';

/** Compared like the server does (ISK-001): trim + NFC. */
const sameName = (a: string, b: string) => a.trim().normalize('NFC') === b.trim().normalize('NFC');
/** The reason box counts code points, like the server's limit. */
const codePoints = (s: string) => [...s];

function statusText(g: AdminGameRow): string {
  if (g.phase !== 'ended') return t.phase[g.phase];
  return g.endedReason === 'closed' ? t.phase.closed : t.phase.ended;
}

/**
 * ISK-002: the admin page's เกม tab. Every game in the server's order (ISK-001's GET /api/admin/games) and the
 * early close of one that has not ended, behind a dialog that wants the game's name typed.
 */
export function AdminGames({ apiBaseUrl, token, onForbidden }: { apiBaseUrl: string; token: string; onForbidden: (message: string) => void }) {
  const [games, setGames] = useState<AdminGameRow[] | 'loading' | { error: string }>('loading');
  const [attempt, setAttempt] = useState(0);
  const [closing, setClosing] = useState<AdminGameRow | null>(null);
  const onForbiddenRef = useRef(onForbidden);
  onForbiddenRef.current = onForbidden;

  useEffect(() => {
    let live = true;
    setGames('loading');
    void fetchAdminGames(apiBaseUrl, token).then((result) => {
      if (!live) return;
      if (result.kind === 'forbidden') return onForbiddenRef.current(result.message);
      setGames(result.kind === 'ok' ? result.data.games : { error: result.message });
    });
    return () => {
      live = false;
    };
  }, [apiBaseUrl, token, attempt]);

  if (games === 'loading') return <Skeleton lines={4} label={t.loading} />;
  if (!Array.isArray(games)) return <ErrorState message={games.error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (games.length === 0) return <EmptyState title={t.empty} />;

  return (
    <>
      <table aria-label={t.title} className="agames">
        <thead>
          <tr>
            <th>{t.head.name}</th>
            <th>{t.head.status}</th>
            <th>{t.head.day}</th>
            <th>{t.head.players}</th>
            <th>{t.head.last}</th>
            <th>{t.head.ai}</th>
            <th>
              <span className="sr-only">{t.close}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => (
            <tr key={g.id}>
              <th scope="row">{g.name}</th>
              <td data-label={t.head.status}>{statusText(g)}</td>
              <td data-label={t.head.day}>{g.day === null ? '-' : t.day(g.day)}</td>
              <td data-label={t.head.players}>{g.playerCount}</td>
              <td data-label={t.head.last}>{g.lastActionAt === null ? '-' : new Date(g.lastActionAt).toLocaleString('th-TH', { hour12: false })}</td>
              <td data-label={t.head.ai}>${g.aiUsd.toFixed(2)}</td>
              <td>
                {g.phase !== 'ended' && (
                  <Button variant="danger" aria-label={t.closeLabel(g.name)} onClick={() => setClosing(g)}>
                    {t.close}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {closing && (
        <CloseGameDialog
          apiBaseUrl={apiBaseUrl}
          token={token}
          game={closing}
          onForbidden={onForbidden}
          onCancel={() => setClosing(null)}
          onClosed={(row) => {
            setGames((list) => (Array.isArray(list) ? list.map((g) => (g.id === row.id ? row : g)) : list));
            setClosing(null);
          }}
        />
      )}
    </>
  );
}

function CloseGameDialog({
  apiBaseUrl,
  token,
  game,
  onForbidden,
  onCancel,
  onClosed,
}: {
  apiBaseUrl: string;
  token: string;
  game: AdminGameRow;
  onForbidden: (message: string) => void;
  onCancel: () => void;
  onClosed: (row: AdminGameRow) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A second press before React re-renders the disabled button must not send again.
  const sending = useRef(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  async function confirm() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await closeAdminGame(apiBaseUrl, token, game.id, { confirmName: typed, ...(reason.trim() ? { reason } : {}) });
    sending.current = false;
    setBusy(false);
    if (result.kind === 'ok') onClosed(result.data);
    else if (result.kind === 'forbidden') onForbidden(result.message);
    else setError(result.message);
  }

  return (
    <div className="dialog-backdrop">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}title`}
        aria-describedby={`${id}text`}
        className="dialog close-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onCancel();
        }}
      >
        <h3 id={`${id}title`} className="dialog__title">
          {t.confirmTitle(game.name)}
        </h3>
        <p id={`${id}text`} className="dialog__text">
          {game.phase === 'playing' ? t.withSummary : t.noSummary} {t.undo}
        </p>
        <label className="close-dialog__field">
          {t.typeName}
          <input ref={first} value={typed} placeholder={game.name} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="close-dialog__field">
          <label htmlFor={`${id}reason`}>{t.reason}</label>
          <textarea
            id={`${id}reason`}
            value={reason}
            rows={3}
            aria-describedby={`${id}count`}
            onChange={(e) => setReason(codePoints(e.target.value).slice(0, CLOSE_REASON_MAX).join(''))}
          />
          <small id={`${id}count`} className="close-dialog__count">
            {codePoints(reason).length}/{CLOSE_REASON_MAX}
          </small>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="dialog__actions">
          <Button onClick={onCancel} disabled={busy}>
            {t.cancel}
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={!sameName(typed, game.name)} loading={busy} loadingText={t.sending}>
            {t.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
