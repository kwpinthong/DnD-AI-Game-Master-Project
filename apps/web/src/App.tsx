import { HealthResponse, type GameView, type Member } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { CreateGameForm } from './CreateGameForm.tsx';
import { JoinForm } from './JoinForm.tsx';
import { Lobby } from './Lobby.tsx';
import { GameHistory, GameSummaryPage } from './GameHistory.tsx';
import { MyStyle } from './MyStyle.tsx';
import { MyGames, type MyGameOpen } from './MyGames.tsx';
import { apiUrl, fetchMe, fetchWithTimeout, loadKnownSessions, loadToken, rememberSession, saveToken, type KnownSession } from './session.ts';

type Status = 'checking' | 'connected' | 'unreachable';

async function checkHealth(baseUrl: string, signal: AbortSignal): Promise<Status> {
  try {
    const res = await fetchWithTimeout(apiUrl(baseUrl, '/health'), {}, signal);
    const body = HealthResponse.safeParse(await res.json());
    return res.ok && body.success && body.data.db === 'connected' ? 'connected' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

const label: Record<Status, string> = {
  checking: 'กำลังตรวจสอบ server…',
  connected: 'Server: ต่อได้ (database connected)',
  unreachable: 'Server: ต่อไม่ได้',
};

/** 'restoring' while a kept token is being checked with GET /api/me. */
/** `game` is set right after creating a game (or from เกมของฉัน, then `enter`), so the lobby opens without another request. */
type Auth =
  | { state: 'restoring' }
  | { state: 'guest' }
  | { state: 'member'; member: Member; token: string; game?: GameView; enter?: boolean };

export function App({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [status, setStatus] = useState<Status>('checking');
  const [auth, setAuth] = useState<Auth>(() => (loadToken() ? { state: 'restoring' } : { state: 'guest' }));
  const [guestView, setGuestView] = useState<'join' | 'create'>('join');
  /** ISK-022: the join form asks only for the PIN of this kept game (its session expired). */
  const [rejoin, setRejoin] = useState<{ inviteCode: string; name: string } | null>(null);
  /** ISK-022: the end page of a kept game, opened from เกมของฉัน (its token). */
  const [summary, setSummary] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showStyle, setShowStyle] = useState(false);
  /** The play room is open (reported by the lobby). */
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    checkHealth(apiBaseUrl, controller.signal).then((next) => {
      if (!controller.signal.aborted) setStatus(next);
    });
    return () => controller.abort();
  }, [apiBaseUrl]);

  useEffect(() => {
    const token = loadToken();
    if (!token) return;
    let cancelled = false;
    fetchMe(apiBaseUrl, token).then((member) => {
      if (cancelled) return;
      if (member === null) saveToken(null);
      // A login kept from before the game list existed joins the list too.
      if (member && member !== 'unreachable') rememberSession({ token, gameId: member.gameId, playerName: member.name });
      // Server unreachable: keep the token for the next visit, show the form meanwhile.
      setAuth(member && member !== 'unreachable' ? { state: 'member', member, token } : { state: 'guest' });
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  function joined(member: Member, token: string, game?: GameView, enter = false) {
    saveToken(token);
    // ISK-022: a join of the same game again replaces its row (new token); the lobby adds the name and the code.
    rememberSession({ token, gameId: member.gameId, playerName: member.name, ...(game ? { gameName: game.name, inviteCode: game.inviteCode } : {}) });
    setRejoin(null);
    setAuth({ state: 'member', member, token, ...(game ? { game } : {}), enter });
  }

  /** ISK-022: a row of เกมของฉัน pressed. */
  function openGame(open: MyGameOpen) {
    if (open.kind === 'summary') return setSummary(open.session.token);
    if (open.kind === 'rejoin') return askPin(open.session);
    const { game, session } = open;
    const name = game.members.find((m) => m.id === game.you.memberId)?.name ?? session.playerName ?? '';
    joined({ id: game.you.memberId, gameId: game.id, name }, session.token, game, true);
  }

  /** The join form with the kept code + name of that game (ISK-022), or blank when this device has neither. */
  function askPin(row: KnownSession | undefined) {
    setGuestView('join');
    setRejoin(row?.inviteCode && row.playerName ? { inviteCode: row.inviteCode, name: row.playerName } : null);
  }

  /** The server refused the session (kicked or expired): back to the join form, asking for the PIN of that game (ISK-022). */
  function sessionLost() {
    if (auth.state === 'member') askPin(loadKnownSessions()?.find((s) => s.token === auth.token));
    saveToken(null);
    setGuestView('join');
    setAuth({ state: 'guest' });
  }

  /** Leaves the screen only (GEN-112): the session and the game stay, so the game stays on the list and name + PIN still enter it. */
  function leave() {
    saveToken(null);
    setAuth({ state: 'guest' });
  }

  return (
    // Q-265: the play room is its own page: the app header is not rendered at all while it is open (nothing left behind to tab to).
    <main className={playing ? 'app--play' : undefined}>
      {!playing && (
        <>
          <h1>Isekai Chronicles</h1>
          <p role="status" data-status={status}>
            {label[status]}
          </p>
          {auth.state !== 'restoring' && (
            <button type="button" aria-pressed={showHistory} onClick={() => setShowHistory((v) => !v)}>
              รายการเกม
            </button>
          )}
          {showHistory && <GameHistory apiBaseUrl={apiBaseUrl} onClose={() => setShowHistory(false)} />}
          <button type="button" aria-pressed={showStyle} onClick={() => setShowStyle((v) => !v)}>
            สไตล์ของฉัน
          </button>
          {showStyle && <MyStyle apiBaseUrl={apiBaseUrl} onClose={() => setShowStyle(false)} />}
        </>
      )}
      {auth.state === 'guest' && summary && <GameSummaryPage apiBaseUrl={apiBaseUrl} token={summary} onBack={() => setSummary(null)} />}
      {auth.state === 'guest' && !summary && guestView === 'join' && (
        <>
          <MyGames apiBaseUrl={apiBaseUrl} onOpen={openGame} />
          <JoinForm
            key={rejoin ? `${rejoin.inviteCode} ${rejoin.name}` : 'blank'}
            apiBaseUrl={apiBaseUrl}
            onJoined={joined}
            {...(rejoin ? { rejoin } : {})}
          />
          <p>
            มี create code?{' '}
            <button type="button" onClick={() => setGuestView('create')}>
              สร้างเกมใหม่
            </button>
          </p>
        </>
      )}
      {auth.state === 'guest' && !summary && guestView === 'create' && (
        <CreateGameForm apiBaseUrl={apiBaseUrl} onCreated={joined} onBack={() => setGuestView('join')} />
      )}
      {auth.state === 'restoring' && <p>กำลังเข้าเกม…</p>}
      {auth.state === 'member' && (
        <section aria-label="ผู้เล่น">
          {!playing && (
            <>
              <p>
                เข้าเกมแล้ว: <strong>{auth.member.name}</strong>
              </p>
              <button type="button" onClick={leave}>
                ออกจากเกม
              </button>
            </>
          )}
          <Lobby
            key={auth.token}
            apiBaseUrl={apiBaseUrl}
            token={auth.token}
            {...(auth.game ? { initial: auth.game } : {})}
            enter={auth.enter ?? false}
            onSessionLost={sessionLost}
            onPlayingChange={setPlaying}
            onGameList={() => setShowHistory(true)}
            onLeave={() => {
              leave();
              setShowHistory(true);
            }}
          />
        </section>
      )}
    </main>
  );
}
