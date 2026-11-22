import type { LearningEntryView, LearningLibraryResponse, LearningType } from '@isekai/protocol';
import { useCallback, useEffect, useState } from 'react';
import { deleteLearningEntry, deleteLearningGame, fetchLearningLibrary, type AdminResult } from './admin-api.ts';
import { Button } from './ui/Button.tsx';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { EmptyState, ErrorState, Skeleton } from './ui/parts.tsx';
import { libraryText as t } from './ui/strings.ts';
import './library.css';

/**
 * The Learning library (GEN-091, Screens and Flows v2 §7): what the AI GM keeps across games, by source game.
 * Only the server owner sees or deletes it (Q-168): it lives behind the admin code and a 403 hands the
 * session back. An entry whose game dropped to 8 or lower shows as suspended (Q-223). Built on the GEN-099
 * contract; the endpoints are GEN-084's.
 */

type State = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: LearningLibraryResponse };
type Confirm = { kind: 'entry'; id: string } | { kind: 'game'; id: string; name: string };

const TYPES: readonly LearningType[] = ['lore', 'feedback_note', 'ruling', 'style'];

const day = (ms: number) => new Date(ms).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });

/** The type's own facts. Numbers are fine here: this is the owner's page, not a player's. */
function detailLine(e: LearningEntryView): string {
  switch (e.type) {
    case 'lore':
      return t.endingPath[e.detail.endingPath];
    case 'feedback_note':
      return t.fromComments(e.detail.fromComments);
    case 'ruling': {
      const d = e.detail;
      const roll = [t.check[d.check], d.dcLabel, d.d20 === null ? null : `d20 ${d.d20}`, t.result[d.result], t.thumbs(d.thumbs, d.players)];
      return roll.filter((part) => part !== null).join(' · ');
    }
    case 'style':
      return `${t.topVerbs}: ${e.detail.topVerbs.join(', ')} · ${t.secretShare(e.detail.secretShare)}`;
  }
}

function Entry({ entry: e, onDelete }: { entry: LearningEntryView; onDelete: () => void }) {
  return (
    <article className={e.status === 'suspended' ? 'lib-entry lib-entry--suspended' : 'lib-entry'}>
      <p className="lib-entry__meta">
        <span className="lib-entry__type">{t.type[e.type]}</span>
        <span>{day(e.createdAt)}</span>
        {e.status === 'suspended' && <span className="lib-entry__suspended">{t.suspended}</span>}
      </p>
      <p className="lib-entry__content">{e.content}</p>
      {e.type === 'ruling' && e.detail.actionText !== e.content && <p className="lib-entry__detail">{e.detail.actionText}</p>}
      <p className="lib-entry__detail">{detailLine(e)}</p>
      {e.tags.length > 0 && (
        <ul className="lib-entry__tags" aria-label="tag">
          {e.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
      {e.status === 'suspended' && <p className="lib-entry__note">{t.suspendedNote}</p>}
      <Button variant="danger" className="lib-entry__delete" onClick={onDelete}>
        {t.remove}
      </Button>
    </article>
  );
}

export function LearningLibrary({ apiBaseUrl, token, onForbidden }: { apiBaseUrl: string; token: string; onForbidden: (message: string) => void }) {
  const [view, setView] = useState<State>({ state: 'loading' });
  const [type, setType] = useState<LearningType | 'all'>('all');
  const [game, setGame] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Takes an answer: the library on success, back to the admin code on a 403; false = it failed. */
  const take = useCallback(
    (result: AdminResult<LearningLibraryResponse>): boolean => {
      if (result.kind === 'forbidden') onForbidden(result.message);
      if (result.kind === 'ok') setView({ state: 'ready', data: result.data });
      return result.kind === 'ok';
    },
    [onForbidden],
  );

  const load = useCallback(async () => {
    setView({ state: 'loading' });
    const result = await fetchLearningLibrary(apiBaseUrl, token);
    if (!take(result) && result.kind === 'error') setView({ state: 'error' });
  }, [apiBaseUrl, token, take]);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(target: Confirm) {
    setBusy(true);
    setDeleteError(null);
    const result = target.kind === 'entry' ? await deleteLearningEntry(apiBaseUrl, token, target.id) : await deleteLearningGame(apiBaseUrl, token, target.id);
    setBusy(false);
    if (take(result) || result.kind === 'forbidden') setConfirm(null);
    else setDeleteError(result.kind === 'error' ? result.message : t.deleteFailed);
  }

  if (view.state === 'loading') return <Skeleton lines={4} />;
  if (view.state === 'error') return <ErrorState message={t.loadFailed} onRetry={() => void load()} />;

  const { entries, counts } = view.data;
  if (entries.length === 0) return <EmptyState title={t.emptyTitle}>{t.emptyText}</EmptyState>;

  const games = [...new Map(entries.map((e) => [e.sourceGameId, { id: e.sourceGameId, name: e.sourceGameName, score: e.sourceScore }])).values()];
  const shown = entries.filter((e) => (type === 'all' || e.type === type) && (game === '' || e.sourceGameId === game));
  const total = TYPES.reduce((sum, k) => sum + counts[k], 0);

  return (
    <div className="lib">
      <p className="lib__owner">{t.ownerOnly}</p>
      <div className="lib__filters">
        <div className="lib__types" role="group" aria-label={t.types}>
          {(['all', ...TYPES] as const).map((k) => (
            <button key={k} type="button" className="lib__type" aria-pressed={type === k} onClick={() => setType(k)}>
              {k === 'all' ? t.all : t.type[k]} <span className="lib__count">{k === 'all' ? total : counts[k]}</span>
            </button>
          ))}
        </div>
        {games.length > 1 && (
          <label className="lib__game-filter">
            {t.sourceGame}
            <select value={game} onChange={(e) => setGame(e.target.value)}>
              <option value="">{t.allGames}</option>
              {games.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {shown.length === 0 && <EmptyState title={t.emptyFilter} />}
      {games
        .filter((g) => shown.some((e) => e.sourceGameId === g.id))
        .map((g) => (
          <section key={g.id} aria-label={t.gameRegion(g.name)} className="lib-game">
            <header className="lib-game__head">
              <h3 className="lib-game__name">{g.name}</h3>
              <p className="lib-game__score">
                {t.score(g.score)}
                {entries.filter((e) => e.sourceGameId === g.id).every((e) => e.status === 'suspended') && <span className="lib-entry__suspended">{t.suspended}</span>}
              </p>
              <Button variant="danger" onClick={() => setConfirm({ kind: 'game', id: g.id, name: g.name })}>
                {t.removeGame}
              </Button>
            </header>
            <div className="lib-game__entries">
              {shown
                .filter((e) => e.sourceGameId === g.id)
                .map((e) => (
                  <Entry key={e.id} entry={e} onDelete={() => setConfirm({ kind: 'entry', id: e.id })} />
                ))}
            </div>
          </section>
        ))}

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'entry' ? t.confirmEntry : t.confirmGame(confirm.name)}
          confirmLabel={confirm.kind === 'entry' ? t.remove : t.removeGameConfirm}
          cancelLabel={t.cancel}
          busy={busy}
          error={deleteError}
          onConfirm={() => void remove(confirm)}
          onCancel={() => {
            setConfirm(null);
            setDeleteError(null);
          }}
        >
          {t.confirmText}
        </ConfirmDialog>
      )}
    </div>
  );
}
