import { HealthResponse, type Member } from '@isekai/protocol';
import { useEffect, useState } from 'react';
import { JoinForm } from './JoinForm.tsx';
import { apiUrl, fetchMe, fetchWithTimeout, loadToken, postLogout, saveToken } from './session.ts';

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
type Auth = { state: 'restoring' } | { state: 'guest' } | { state: 'member'; member: Member; token: string };

export function App({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [status, setStatus] = useState<Status>('checking');
  const [auth, setAuth] = useState<Auth>(() => (loadToken() ? { state: 'restoring' } : { state: 'guest' }));

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
      // Server unreachable: keep the token for the next visit, show the form meanwhile.
      setAuth(member && member !== 'unreachable' ? { state: 'member', member, token } : { state: 'guest' });
    });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  function joined(member: Member, token: string) {
    saveToken(token);
    setAuth({ state: 'member', member, token });
  }

  function logout() {
    if (auth.state === 'member') void postLogout(apiBaseUrl, auth.token);
    saveToken(null);
    setAuth({ state: 'guest' });
  }

  return (
    <main>
      <h1>Isekai Chronicles</h1>
      <p role="status" data-status={status}>
        {label[status]}
      </p>
      {auth.state === 'guest' && <JoinForm apiBaseUrl={apiBaseUrl} onJoined={joined} />}
      {auth.state === 'restoring' && <p>กำลังเข้าเกม…</p>}
      {auth.state === 'member' && (
        <section aria-label="ผู้เล่น">
          <p>
            เข้าเกมแล้ว: <strong>{auth.member.name}</strong>
          </p>
          <button type="button" onClick={logout}>
            ออกจากเกม
          </button>
        </section>
      )}
    </main>
  );
}
