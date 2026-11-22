import { HealthResponse, type GameView, type Member } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { CreateGameForm } from './CreateGameForm.tsx';
import { JoinForm } from './JoinForm.tsx';
import { Lobby } from './Lobby.tsx';
import { GameHistory } from './GameHistory.tsx';
import { apiUrl, fetchMe, fetchWithTimeout, forgetToken, loadToken, rememberToken, saveToken } from './session.ts';

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
/** `game` is set right after creating a game, so the lobby opens without another request. */
type Auth =
  | { state: 'restoring' }
  | { state: 'guest' }
  | { state: 'member'; member: Member; token: string; game?: GameView };

export function App({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [status, setStatus] = useState<Status>('checking');
  const [auth, setAuth] = useState<Auth>(() => (loadToken() ? { state: 'restoring' } : { state: 'guest' }));
  const [guestView, setGuestView] = useState<'join' | 'create'>('join');
  const [showHistory, setShowHistory] = useState(false);

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
      if (member && member !== 'unreachable') rememberToken(token);
      // Server unreachable: keep the token for the next visit, show the form meanwhile.
      setAuth(member && member !== 'unreachable' ? { state: 'member', member, token } : { state: 'guest' });
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  function joined(member: Member, token: string, game?: GameView) {
    saveToken(token);
    rememberToken(token);
    setAuth({ state: 'member', member, token, ...(game ? { game } : {}) });
  }

  /** The server refused the session (kicked or expired): back to the join form. */
  function sessionLost() {
    if (auth.state === 'member') forgetToken(auth.token);
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
    <main>
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
      {auth.state === 'guest' && guestView === 'join' && (
        <>
          <JoinForm apiBaseUrl={apiBaseUrl} onJoined={joined} />
          <p>
            มี create code?{' '}
            <button type="button" onClick={() => setGuestView('create')}>
              สร้างเกมใหม่
            </button>
          </p>
        </>
      )}
      {auth.state === 'guest' && guestView === 'create' && (
        <CreateGameForm apiBaseUrl={apiBaseUrl} onCreated={joined} onBack={() => setGuestView('join')} />
      )}
      {auth.state === 'restoring' && <p>กำลังเข้าเกม…</p>}
      {auth.state === 'member' && (
        <section aria-label="ผู้เล่น">
          <p>
            เข้าเกมแล้ว: <strong>{auth.member.name}</strong>
          </p>
          <button type="button" onClick={leave}>
            ออกจากเกม
          </button>
          <Lobby
            key={auth.token}
            apiBaseUrl={apiBaseUrl}
            token={auth.token}
            {...(auth.game ? { initial: auth.game } : {})}
            onSessionLost={sessionLost}
          />
        </section>
      )}
    </main>
  );
}
