import { useEffect, useState } from 'react';
import { CharacterScreen } from './CharacterScreen.tsx';
import { currentDay, loadLateJoin, saveLateJoin, spawnCall, takeLateJoin, type LateJoinMark } from './late-join.ts';
import { FeedbackButton } from './ui/FeedbackDialog.tsx';
import { Button, Panel } from './ui/index.ts';
import { lateJoinText as t } from './ui/strings.ts';
import './pregame.css';

/**
 * ISK-016: the setup of a player who joined a started game: the character steps (the usual page), then the spawn
 * step, under a banner with the day they joined on. Play opens only after the spawn (`onSpawned`); the crossing
 * story is the origin card on the way in.
 */
export function LateJoinSetup({
  apiBaseUrl,
  token,
  onSessionLost,
  onSpawned,
}: {
  apiBaseUrl: string;
  token: string;
  onSessionLost: () => void;
  /** Spawned, or already in the game: open Play. */
  onSpawned: () => void;
}) {
  const [mark, setMark] = useState<LateJoinMark | null>(() => loadLateJoin(token));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (mark) return;
    let cancelled = false;
    void currentDay(apiBaseUrl, token).then((day) => {
      if (cancelled || loadLateJoin(token)) return;
      const first: LateJoinMark = { day, step: 'character' };
      saveLateJoin(token, first);
      setMark(first);
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, token]);

  function goTo(step: LateJoinMark['step']) {
    const next = { day: mark?.day ?? null, step };
    saveLateJoin(token, next);
    setMark(next);
    setProblem(undefined);
  }

  function done() {
    takeLateJoin(token);
    onSpawned();
  }

  async function spawn() {
    if (busy) return;
    setBusy(true);
    const result = await spawnCall(apiBaseUrl, token);
    setBusy(false);
    if (result.kind === 'session_lost') return onSessionLost();
    if (result.kind === 'error') return setProblem(result.message);
    done();
  }

  // Shown once the join day is known, so it never changes under the reader.
  const banner = mark && (
    <p className="late-join" role="status">
      {t.banner(mark.day)}
    </p>
  );

  if (mark?.step === 'spawn') {
    return (
      <div className="pregame">
        <FeedbackButton apiBaseUrl={apiBaseUrl} token={token} page="spawn" />
        {banner}
        <Panel title={t.spawn.title} className="pregame__panel">
          <h2 className="pregame__title">{t.spawn.title}</h2>
          <p className="pregame__lead">{t.spawn.lead}</p>
          <p className="pregame__note">{t.spawn.note}</p>
          {problem && (
            <p className="field-error pregame__form-error" role="alert">
              {problem}
            </p>
          )}
          <div className="pregame__actions pregame__actions--split">
            <Button disabled={busy} onClick={() => goTo('character')}>
              {t.spawn.back}
            </Button>
            <Button variant="primary" loading={busy} loadingText={t.spawn.going} onClick={() => void spawn()}>
              {t.spawn.go}
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <>
      <div className="pregame">{banner}</div>
      <CharacterScreen
        apiBaseUrl={apiBaseUrl}
        token={token}
        onSessionLost={onSessionLost}
        // A character that cannot be edited any more: they are in the game already.
        onGameStarted={done}
        onConfirm={() => goTo('spawn')}
      />
    </>
  );
}
