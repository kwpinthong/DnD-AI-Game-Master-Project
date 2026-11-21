import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { TOKEN_KEY } from '../src/session.ts';

const member = { id: 'm-1', gameId: 'g-1', name: 'นก' };
const joined = { token: 'tok-abc', expiresAt: '2026-12-21T12:00:00.000Z', created: true, member };

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
    const path = Object.keys(routes).find((p) => url.endsWith(p));
    if (!path) throw new Error(`unexpected request ${url}`);
    return routes[path]!(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof stubApi>, path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith(path));

function fillAndSubmit(values: { inviteCode?: string; name?: string; pin?: string }) {
  const { inviteCode = 'K7Q2MX', name = 'นก', pin = '1234' } = values;
  fireEvent.change(screen.getByLabelText('โค้ดเกม'), { target: { value: inviteCode } });
  fireEvent.change(screen.getByLabelText('ชื่อผู้เล่น'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('PIN'), { target: { value: pin } });
  fireEvent.click(screen.getByRole('button', { name: 'เข้าร่วม' }));
}

describe('Join page', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('C1: joins with code + name + PIN, keeps the session and shows the member', async () => {
    const fetchMock = stubApi({ '/api/join': () => Response.json(joined) });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({});

    expect(await screen.findByText(/เข้าเกมแล้ว/)).toBeTruthy();
    expect(screen.getByText(/นก/)).toBeTruthy();
    const [call] = callsTo(fetchMock, '/api/join');
    expect(call![1]?.method).toBe('POST');
    expect(JSON.parse(String(call![1]?.body))).toEqual({ inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' });
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-abc');
  });

  it('C3: shows "PIN ไม่ถูกต้อง" at the PIN field and stays logged out', async () => {
    stubApi({
      '/api/join': () =>
        Response.json({ code: 'wrong_pin', message: 'PIN ไม่ถูกต้อง เหลือ 4 ครั้ง', attemptsLeft: 4 }, { status: 401 }),
    });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({ pin: '9999' });

    expect(await screen.findByText('PIN ไม่ถูกต้อง เหลือ 4 ครั้ง')).toBeTruthy();
    expect(screen.getByLabelText('PIN').getAttribute('aria-invalid')).toBe('true');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('C4: says the name is locked and the local time it can try again', async () => {
    const retryAt = new Date(2026, 10, 21, 14, 5, 0);
    stubApi({
      '/api/join': () =>
        Response.json(
          { code: 'locked', message: 'ชื่อนี้ถูกล็อกชั่วคราว', retryAt: retryAt.toISOString() },
          { status: 429 },
        ),
    });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({});

    expect(await screen.findByText(/ถูกล็อกชั่วคราว.*ลองใหม่ได้เวลา 14:05/)).toBeTruthy();
  });

  it('C5: shows "ไม่พบเกม" at the invite code field', async () => {
    stubApi({
      '/api/join': () =>
        Response.json({ code: 'game_not_found', message: 'ไม่พบเกมจากโค้ดนี้ ตรวจตัวอักษรอีกครั้ง' }, { status: 404 }),
    });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({ inviteCode: 'ZZZZZZ' });

    expect(await screen.findByText(/ไม่พบเกม/)).toBeTruthy();
    expect(screen.getByLabelText('โค้ดเกม').getAttribute('aria-invalid')).toBe('true');
  });

  it('C6: a 3-digit PIN and an empty name are flagged per field without calling the server', async () => {
    const fetchMock = stubApi({ '/api/join': () => Response.json(joined) });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({ name: '', pin: '123' });

    expect(await screen.findByText('PIN ต้องเป็นตัวเลข 4-6 หลัก')).toBeTruthy();
    expect(screen.getByText('กรุณาใส่ชื่อผู้เล่น')).toBeTruthy();
    expect(screen.getByLabelText('PIN').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('ชื่อผู้เล่น').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('โค้ดเกม').getAttribute('aria-invalid')).toBe('false');
    expect(callsTo(fetchMock, '/api/join')).toHaveLength(0);
  });

  it('C6: shows the field errors the server sends back', async () => {
    stubApi({
      '/api/join': () =>
        Response.json(
          { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { name: 'ชื่อยาวได้ไม่เกิน 32 ตัวอักษร' } },
          { status: 400 },
        ),
    });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({});

    expect(await screen.findByText('ชื่อยาวได้ไม่เกิน 32 ตัวอักษร')).toBeTruthy();
    expect(screen.getByLabelText('ชื่อผู้เล่น').getAttribute('aria-invalid')).toBe('true');
  });

  it('C7: a kept session is checked with GET /api/me and the page opens logged in', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-abc');
    const fetchMock = stubApi({ '/api/me': () => Response.json({ member }) });

    render(<App apiBaseUrl="https://api.isekai.example" />);

    expect(await screen.findByText(/เข้าเกมแล้ว/)).toBeTruthy();
    const [call] = callsTo(fetchMock, '/api/me');
    expect(String(call![0])).toBe('https://api.isekai.example/api/me');
    expect(new Headers(call![1]?.headers).get('authorization')).toBe('Bearer tok-abc');
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });

  it('C7: an expired session falls back to the join form and forgets the token', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-old');
    stubApi({
      '/api/me': () => Response.json({ code: 'unauthorized', message: 'session หมดอายุ' }, { status: 401 }),
    });

    render(<App apiBaseUrl="" />);

    expect(await screen.findByLabelText('PIN')).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBeNull());
  });

  it('logging out forgets the token and shows the join form again', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-abc');
    const fetchMock = stubApi({
      '/api/me': () => Response.json({ member }),
      '/api/logout': () => new Response(null, { status: 204 }),
    });

    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'ออกจากเกม' }));

    expect(await screen.findByLabelText('PIN')).toBeTruthy();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    const [call] = callsTo(fetchMock, '/api/logout');
    expect(new Headers(call![1]?.headers).get('authorization')).toBe('Bearer tok-abc');
  });
});
