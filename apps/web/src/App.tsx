import { HealthResponse } from '@isekai/protocol';
import { useEffect, useState } from 'react';

type Status = 'checking' | 'connected' | 'unreachable';

/** Joins the API base URL ('' = same origin via the Vite proxy) with a path. */
export function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function checkHealth(baseUrl: string, signal: AbortSignal): Promise<Status> {
  try {
    const res = await fetch(apiUrl(baseUrl, '/health'), { signal });
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

export function App({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    const controller = new AbortController();
    checkHealth(apiBaseUrl, controller.signal).then((next) => {
      if (!controller.signal.aborted) setStatus(next);
    });
    return () => controller.abort();
  }, [apiBaseUrl]);

  return (
    <main>
      <h1>Isekai Chronicles</h1>
      <p role="status" data-status={status}>
        {label[status]}
      </p>
    </main>
  );
}
