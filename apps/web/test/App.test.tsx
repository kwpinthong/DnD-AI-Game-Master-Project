import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';

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
