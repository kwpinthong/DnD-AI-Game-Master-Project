import { VOTE_REASON_LABEL, VoteReason, type AdminDownvoteEntry, type AdminDownvotesResponse } from '@isekai/protocol';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchCorrectionsExport, fetchDownvotes, fetchVoteSnapshotsExport, postCorrection, type AdminResult } from './admin-api.ts';
import { Button } from './ui/Button.tsx';
import { EmptyState, ErrorState, Skeleton } from './ui/parts.tsx';
import { reviewText as t } from './ui/strings.ts';

/**
 * GEN-168: the AI messages players gave a 👎, filtered by reason / NPC, with "แก้เป็น": the owner types the
 * version it should have been and the server keeps the pair (the game's text stays). Behind the admin code.
 */

type State = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: AdminDownvotesResponse };

interface Props {
  apiBaseUrl: string;
  token: string;
  onForbidden: (message: string) => void;
}

function EditForm({ entry, onSave, onCancel }: { entry: AdminDownvoteEntry; onSave: (edited: string, toLibrary: boolean) => Promise<string | null>; onCancel: () => void }) {
  const [edited, setEdited] = useState(entry.text);
  const [toLibrary, setToLibrary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const problem = await onSave(edited, toLibrary);
    setBusy(false);
    setError(problem);
  }
  return (
    <form className="vote-review__form" onSubmit={submit}>
      <label>
        {t.edited}
        <textarea rows={3} maxLength={2000} value={edited} onChange={(e) => setEdited(e.target.value)} />
      </label>
      <label className="vote-review__check">
        <input type="checkbox" checked={toLibrary} onChange={(e) => setToLibrary(e.target.checked)} /> {t.toLibrary}
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="vote-review__actions">
        <Button type="submit" variant="primary" loading={busy}>
          {t.save}
        </Button>
        <Button onClick={onCancel}>{t.cancel}</Button>
      </div>
    </form>
  );
}

export function VoteReview({ apiBaseUrl, token, onForbidden }: Props) {
  const [state, setState] = useState<State>({ state: 'loading' });
  const [reason, setReason] = useState('');
  const [npc, setNpc] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const [exported, setExported] = useState<{ jsonl: string; count: number } | null>(null);
  const [votesExported, setVotesExported] = useState<{ jsonl: string; count: number } | null>(null);

  /** Returns the data, or null after handling a 403 / an error. */
  const take = useCallback(
    <T,>(result: AdminResult<T>): T | null => {
      if (result.kind === 'ok') return result.data;
      if (result.kind === 'forbidden') onForbidden(result.message);
      return null;
    },
    [onForbidden],
  );

  const load = useCallback(async () => {
    const data = take(await fetchDownvotes(apiBaseUrl, token));
    setState(data ? { state: 'ready', data } : { state: 'error' });
  }, [apiBaseUrl, token, take]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.state === 'loading') return <Skeleton lines={3} />;
  if (state.state === 'error') return <ErrorState message={t.loadFailed} onRetry={() => void load()} />;

  const key = (e: AdminDownvoteEntry) => `${e.gameId}/${e.seq}`;
  const npcs = [...new Map(state.data.entries.flatMap((e) => (e.npc ? [[e.npc.id, e.npc.name] as const] : []))).entries()];
  const shown = state.data.entries.filter((e) => (reason === '' || (e.reasons[reason as VoteReason] ?? 0) > 0) && (npc === '' || e.npc?.id === npc));

  async function save(entry: AdminDownvoteEntry, edited: string, toLibrary: boolean): Promise<string | null> {
    const result = await postCorrection(apiBaseUrl, token, { gameId: entry.gameId, seq: entry.seq, edited, toLibrary });
    if (result.kind !== 'ok') {
      if (result.kind === 'forbidden') onForbidden(result.message);
      return result.message;
    }
    setSaved((s) => new Set(s).add(key(entry)));
    setEditing(null);
    void load();
    return null;
  }

  async function exportPairs() {
    const data = take(await fetchCorrectionsExport(apiBaseUrl, token));
    if (data) setExported({ jsonl: data.jsonl, count: data.count });
  }

  async function exportVotes() {
    const data = take(await fetchVoteSnapshotsExport(apiBaseUrl, token));
    if (data) setVotesExported({ jsonl: data.jsonl, count: data.count });
  }

  return (
    <div className="vote-review">
      <div className="vote-review__tools">
        <label>
          {t.reason}
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">{t.any}</option>
            {VoteReason.options.map((r) => (
              <option key={r} value={r}>
                {VOTE_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.npc}
          <select value={npc} onChange={(e) => setNpc(e.target.value)}>
            <option value="">{t.any}</option>
            {npcs.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void exportPairs()}>{t.export}</Button>
        {exported && (
          <a download="corrections.jsonl" href={`data:application/x-ndjson;charset=utf-8,${encodeURIComponent(exported.jsonl)}`}>
            {t.download(exported.count)}
          </a>
        )}
        <Button onClick={() => void exportVotes()}>{t.exportVotes}</Button>
        {votesExported && (
          <a download="vote-snapshots.jsonl" href={`data:application/x-ndjson;charset=utf-8,${encodeURIComponent(votesExported.jsonl)}`}>
            {t.downloadVotes(votesExported.count)}
          </a>
        )}
      </div>
      {state.data.entries.length === 0 ? (
        <EmptyState title={t.none} />
      ) : shown.length === 0 ? (
        <p>{t.noMatch}</p>
      ) : (
        <ul className="vote-review__list">
          {shown.map((e) => (
            <li key={key(e)} className="vote-review__item">
              <p className="vote-review__meta">
                {e.gameName} · {`วันที่ ${e.at.day} · ${e.at.phase} · เทิร์น ${e.at.turn}`} · {t.scene[e.scene]}
                {e.npc && ` · ${e.npc.name}`} · {t.down(e.down)}
              </p>
              <p className="vote-review__text">{e.text}</p>
              {Object.keys(e.reasons).length > 0 && (
                <p className="vote-review__reasons">{VoteReason.options.filter((r) => e.reasons[r]).map((r) => `${VOTE_REASON_LABEL[r]} ${e.reasons[r]}`).join(' · ')}</p>
              )}
              {e.corrections.length > 0 && <p className="vote-review__pairs">{t.pairs(e.corrections.length)}: {e.corrections.at(-1)!.edited}</p>}
              {saved.has(key(e)) && <p role="status">{t.saved}</p>}
              {editing === key(e) ? (
                <EditForm entry={e} onSave={(edited, toLibrary) => save(e, edited, toLibrary)} onCancel={() => setEditing(null)} />
              ) : (
                <Button aria-label={t.edit(e.text)} onClick={() => setEditing(key(e))}>
                  {t.editLabel}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
