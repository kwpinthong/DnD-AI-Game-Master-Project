import { ReviewScene, type NpcChoice, type NpcExampleAddRequest, type NpcLibraryResponse } from '@isekai/protocol';
import { useCallback, useEffect, useState } from 'react';
import { addNpcExample, deleteNpcExample, fetchNpcLibrary, type AdminResult } from './admin-api.ts';
import { Button } from './ui/Button.tsx';
import { ConfirmDialog } from './ui/ConfirmDialog.tsx';
import { EmptyState, ErrorState, Skeleton } from './ui/parts.tsx';
import { npcLibraryText as t, reviewText } from './ui/strings.ts';

/**
 * GEN-151: the NPC example library, on the Learning library page (Q-322), behind the admin code. Examples per NPC
 * (delete), and what may go in: 👍 messages (pick the NPC and the scene kind) and "แก้เป็น" pairs sent to the
 * library whose message was not an NPC's (pick the NPC).
 */

type State = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: NpcLibraryResponse };

interface Props {
  apiBaseUrl: string;
  token: string;
  onForbidden: (message: string) => void;
}

function AddForm({ choices, npcId, scene, label, onAdd }: { choices: readonly NpcChoice[]; npcId: string; scene?: ReviewScene; label: string; onAdd: (npcId: string, scene?: ReviewScene) => Promise<string | null> }) {
  const [npc, setNpc] = useState(npcId);
  const [kind, setKind] = useState(scene);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setError(await onAdd(npc, kind));
    setBusy(false);
  }
  return (
    <div className="npc-lib__add">
      <label>
        {t.npc}
        <select value={npc} onChange={(e) => setNpc(e.target.value)}>
          <option value="">{t.pickNpc}</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {kind !== undefined && (
        <label>
          {t.scene}
          <select value={kind} onChange={(e) => setKind(e.target.value as ReviewScene)}>
            {ReviewScene.options.map((s) => (
              <option key={s} value={s}>
                {reviewText.scene[s]}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button aria-label={label} disabled={npc === ''} loading={busy} onClick={() => void add()}>
        {t.add}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function NpcLibrary({ apiBaseUrl, token, onForbidden }: Props) {
  const [view, setView] = useState<State>({ state: 'loading' });
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Takes an answer: null on success (the new library shown), else the problem. */
  const take = useCallback(
    (result: AdminResult<NpcLibraryResponse>): string | null => {
      if (result.kind === 'ok') {
        setView({ state: 'ready', data: result.data });
        return null;
      }
      if (result.kind === 'forbidden') onForbidden(result.message);
      return result.message || t.failed;
    },
    [onForbidden],
  );

  const load = useCallback(async () => {
    const result = await fetchNpcLibrary(apiBaseUrl, token);
    if (take(result) !== null && result.kind === 'error') setView({ state: 'error' });
  }, [apiBaseUrl, token, take]);
  useEffect(() => {
    void load();
  }, [load]);

  if (view.state === 'loading') return <Skeleton lines={3} />;
  if (view.state === 'error') return <ErrorState message={t.loadFailed} onRetry={() => void load()} />;

  const { npcs, upvoted, candidates, npcChoices, goodLines } = view.data;
  const names = new Map([...goodLines.map((l) => [l.npc.id, l.npc.name] as const), ...npcChoices.map((c) => [c.id, c.name] as const), ...npcs.map((n) => [n.npcId, n.npcName] as const)]);
  /** The owner reads words, not tokens. */
  const words = (text: string) => text.replace(/\{\{p:[^}]+\}\}/g, t.player).replace(/\{\{n:([^}]+)\}\}/g, (_, id: string) => names.get(id) ?? id);
  const add = async (body: NpcExampleAddRequest) => take(await addNpcExample(apiBaseUrl, token, body));

  async function remove(id: number) {
    setBusy(true);
    setDeleteError(null);
    const problem = take(await deleteNpcExample(apiBaseUrl, token, id));
    setBusy(false);
    if (problem === null) setConfirm(null);
    else setDeleteError(problem);
  }

  return (
    <div className="lib npc-lib">
      <p className="lib__owner">{t.intro}</p>
      {npcs.length === 0 && <EmptyState title={t.none} />}
      {npcs.map((n) => (
        <section key={n.npcId} aria-label={t.npcRegion(n.npcName, n.examples.length)} className="lib-game">
          <header className="lib-game__head">
            <h3 className="lib-game__name">{t.npcRegion(n.npcName, n.examples.length)}</h3>
          </header>
          <div className="lib-game__entries">
            {n.examples.map((e) => (
              <article key={e.id} className="lib-entry">
                <p className="lib-entry__meta">
                  <span className="lib-entry__type">{reviewText.scene[e.scene]}</span>
                  <span>{t.source[e.source]}</span>
                </p>
                <p className="lib-entry__content">{words(e.text)}</p>
                <Button variant="danger" className="lib-entry__delete" aria-label={t.removeLabel(words(e.text))} onClick={() => setConfirm(e.id)}>
                  {t.remove}
                </Button>
              </article>
            ))}
          </div>
        </section>
      ))}

      {/* GEN-084 (Q-322): GEN-081's good NPC lines, one click to the NPC they belong to. */}
      <section aria-label={t.goodLinesTitle}>
        <h3>{t.goodLinesTitle}</h3>
        <p className="lib__owner">{t.goodLinesNote}</p>
        {goodLines.length === 0 ? (
          <p>{t.noGoodLines}</p>
        ) : (
          <ul className="npc-lib__list">
            {goodLines.map((l) => (
              <li key={`${l.gameId}/${l.seq}`} className="lib-entry">
                <p className="lib-entry__meta">{`${l.npc.name} · ${t.up(l.up)}`}</p>
                <p className="lib-entry__content">{words(l.text)}</p>
                <AddForm choices={npcChoices} npcId={l.npc.id} scene="npc-dialogue" label={t.addLabel(words(l.text))} onAdd={(npcId, scene) => add({ from: 'vote', gameId: l.gameId, seq: l.seq, npcId, scene: scene ?? 'npc-dialogue' })} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t.upvotedTitle}>
        <h3>{t.upvotedTitle}</h3>
        {upvoted.length === 0 ? (
          <p>{t.noUpvoted}</p>
        ) : (
          <ul className="npc-lib__list">
            {upvoted.map((e) => (
              <li key={`${e.gameId}/${e.seq}`} className="lib-entry">
                <p className="lib-entry__meta">
                  {e.gameName} · {reviewText.scene[e.scene]}
                  {e.npc && ` · ${e.npc.name}`} · {t.up(e.up)}
                </p>
                <p className="lib-entry__content">{e.text}</p>
                {e.inLibrary ? (
                  <p>{t.added}</p>
                ) : (
                  <AddForm choices={npcChoices} npcId={e.npc?.id ?? ''} scene={e.scene} label={t.addLabel(e.text)} onAdd={(npcId, scene) => add({ from: 'vote', gameId: e.gameId, seq: e.seq, npcId, scene: scene ?? e.scene })} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {candidates.length > 0 && (
        <section aria-label={t.candidatesTitle}>
          <h3>{t.candidatesTitle}</h3>
          <ul className="npc-lib__list">
            {candidates.map((c) => (
              <li key={c.id} className="lib-entry">
                <p className="lib-entry__meta">{reviewText.scene[c.scene]}</p>
                <p className="lib-entry__content">{c.edited}</p>
                <AddForm choices={npcChoices} npcId="" label={t.addLabel(c.edited)} onAdd={(npcId) => add({ from: 'correction', correctionId: c.id, npcId })} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirm !== null && (
        <ConfirmDialog
          title={t.confirm}
          confirmLabel={t.remove}
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
