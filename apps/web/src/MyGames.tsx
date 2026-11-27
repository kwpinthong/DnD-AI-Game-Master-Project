import type { GameView } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { myGameState, type MyGameState } from './game-api.ts';
import { forgetSession, loadKnownSessions, type KnownSession } from './session.ts';
import { Button, Panel } from './ui/index.ts';
import { myGamesText as t } from './ui/strings.ts';
import './pregame.css';

/** What a pressed row opens: the game (lobby / setup / play), its end page, or the join form asking for the PIN. */
export type MyGameOpen =
  | { kind: 'game'; session: KnownSession; game: GameView }
  | { kind: 'summary'; session: KnownSession }
  | { kind: 'rejoin'; session: KnownSession };

type RowState = MyGameState | { kind: 'loading' };

const statusOf = (state: RowState): string => (state.kind === 'playing' ? t.status.playing(state.day) : t.status[state.kind]);

function openOf(session: KnownSession, state: RowState): MyGameOpen | null {
  switch (state.kind) {
    case 'lobby':
    case 'setup':
    case 'playing':
      return { kind: 'game', session, game: state.game };
    case 'ended':
      return { kind: 'summary', session };
    case 'closed':
      // closed before it was played: there is no end page to open
      return state.game.closed?.hasSummary ? { kind: 'summary', session } : null;
    case 'expired':
      return { kind: 'rejoin', session };
    default:
      return null;
  }
}

/**
 * ISK-022: เกมของฉัน, the rows of `isekai.knownSessions` newest first, each with where its game is (asked with the row's
 * own token, so one row that cannot connect leaves the others alone). Nothing at all when this browser's storage
 * cannot be used (C6). [เอาออกจากรายการ] forgets the row on this device only. `sessions`: the gallery's rows.
 */
export function MyGames({ apiBaseUrl, onOpen, sessions: given }: { apiBaseUrl: string; onOpen: (open: MyGameOpen) => void; sessions?: readonly KnownSession[] }) {
  const [sessions, setSessions] = useState<readonly KnownSession[] | null>(() => given ?? loadKnownSessions());
  const [states, setStates] = useState<Record<string, MyGameState>>({});
  const [removed, setRemoved] = useState<string>();

  function load(token: string) {
    setStates(({ [token]: _old, ...rest }) => rest);
    void myGameState(apiBaseUrl, token).then((state) => setStates((s) => ({ ...s, [token]: state })));
  }

  useEffect(() => {
    for (const s of sessions ?? []) load(s.token);
  }, [apiBaseUrl]);

  if (!sessions) return null;

  function remove(session: KnownSession, name: string) {
    forgetSession(session.token);
    setSessions((list) => list && list.filter((r) => r.token !== session.token));
    setRemoved(t.removed(name));
  }

  return (
    <div className="pregame">
      <Panel title={t.title} className="pregame__panel my-games">
        <h2 className="pregame__title">{t.title}</h2>
        {removed && (
          <p role="status" className="pregame__note">
            {removed}
          </p>
        )}
        {sessions.length === 0 ? (
          <p className="pregame__lead">{t.empty}</p>
        ) : (
          <ul className="my-games__list">
            {sessions.map((s) => {
              const state: RowState = states[s.token] ?? { kind: 'loading' };
              const name = s.gameName ?? ('game' in state ? state.game.name : t.unnamed);
              const open = openOf(s, state);
              return (
                <li key={s.token} className="my-games__row">
                  <div className="my-games__info">
                    <strong>{name}</strong>
                    {s.playerName && <small>{t.as(s.playerName)}</small>}
                    <span className="my-games__status">{statusOf(state)}</span>
                  </div>
                  <div className="my-games__actions">
                    {open && (
                      <Button variant="primary" onClick={() => onOpen(open)}>
                        {open.kind === 'summary' ? t.summary : t.enter}
                      </Button>
                    )}
                    {state.kind === 'offline' && <Button onClick={() => load(s.token)}>{t.retry}</Button>}
                    <Button onClick={() => remove(s, name)}>{t.remove}</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
