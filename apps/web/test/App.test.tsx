import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { REQUEST_TIMEOUT_MS, TOKEN_KEY } from '../src/session.ts';

/** A fetch that never answers, like a server that accepts the connection and hangs; it obeys abort. */
function hangingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

// GEN-041a C7: Given the server is down or a deploy failed / When the web opens /
// Then it shows "ต่อไม่ได้", never a raw error.
describe('home page when the server on Railway is down', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  const railwayErrorPage = '<!DOCTYPE html><html><body><h1>Application failed to respond</h1></body></html>';

  it('shows "ต่อไม่ได้" for a 502 HTML error page from the proxy, without its text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(railwayErrorPage, { status: 502, headers: { 'content-type': 'text/html' } })));

    render(<App apiBaseUrl="https://isekai.up.railway.app" />);

    expect(await screen.findByText(/ต่อไม่ได้/)).toBeTruthy();
    expect(screen.queryByText(/Application failed to respond/)).toBeNull();
  });

  it('shows "ต่อไม่ได้" when /health answers 200 with HTML (VITE_API_URL pointing at the site itself)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><div id="root"></div>', { status: 200 })));

    render(<App apiBaseUrl="" />);

    expect(await screen.findByText(/ต่อไม่ได้/)).toBeTruthy();
  });

  it(`shows "ต่อไม่ได้" when /health does not answer within ${REQUEST_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(hangingFetch));

    render(<App apiBaseUrl="https://isekai.up.railway.app" />);
    expect(screen.getByRole('status').textContent).toMatch(/กำลังตรวจสอบ/);
    await act(() => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS));

    expect(screen.getByRole('status').textContent).toMatch(/ต่อไม่ได้/);
  });

  it('a kept login does not hang on "กำลังเข้าเกม…" when /api/me never answers; the token is kept', async () => {
    vi.useFakeTimers();
    localStorage.setItem(TOKEN_KEY, 'tok-kept');
    vi.stubGlobal('fetch', vi.fn(hangingFetch));

    render(<App apiBaseUrl="https://isekai.up.railway.app" />);
    expect(screen.getByText('กำลังเข้าเกม…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS));

    expect(screen.queryByText('กำลังเข้าเกม…')).toBeNull();
    expect(screen.getByRole('button', { name: 'เข้าร่วม' })).toBeTruthy();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-kept');
  });
});

// C6: Given the web dev server / When the first page opens / Then it shows the /health status.
describe('home page server status', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: (url: string) => Promise<Response>) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => impl(String(input)));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('shows "ต่อได้" when /health reports the database as connected', async () => {
    const fetchMock = stubFetch(async () => Response.json({ ok: true, db: 'connected' }));

    render(<App apiBaseUrl="" />);

    expect(await screen.findByText(/ต่อได้/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/health', expect.anything());
  });

  it('shows "ต่อไม่ได้" when /health answers 503 with a database error', async () => {
    stubFetch(async () => Response.json({ ok: false, db: 'error' }, { status: 503 }));

    render(<App apiBaseUrl="" />);

    expect(await screen.findByText(/ต่อไม่ได้/)).toBeTruthy();
  });

  it('shows "ต่อไม่ได้" when the server cannot be reached', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    render(<App apiBaseUrl="" />);

    expect(await screen.findByText(/ต่อไม่ได้/)).toBeTruthy();
  });

  it('calls the API base URL it is given (VITE_API_URL on Netlify)', async () => {
    const fetchMock = stubFetch(async () => Response.json({ ok: true, db: 'connected' }));

    render(<App apiBaseUrl="https://api.isekai.example/" />);

    expect(await screen.findByText(/ต่อได้/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('https://api.isekai.example/health', expect.anything());
  });
});
