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
  // GEN-090 C2: a field tells its error once the player leaves it, and the button is off while one is wrong.
  for (const [label, value] of [['โค้ดเกม', inviteCode], ['ชื่อผู้เล่น', name], ['PIN', pin]] as const) {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }
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

  // GEN-025: a full game, a started game and a kicked name are refused with the server's message.
  it.each([
    ['game_full', 409, 'เกมเต็ม (ผู้เล่นครบ 6 คนแล้ว)'],
    ['game_started', 409, 'เกมนี้เริ่มไปแล้ว รับคนเพิ่มไม่ได้'],
    ['kicked', 403, 'ชื่อนี้ถูกเจ้าของเกมเชิญออกแล้ว เข้าเกมนี้อีกไม่ได้'],
  ])('GEN-025: shows the %s message and stays logged out', async (code, status, message) => {
    stubApi({ '/api/join': () => Response.json({ code, message }, { status }) });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({});

    expect(await screen.findByText(message)).toBeTruthy();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
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

  // GEN-092: a Thai keyboard on the number row.
  it('GEN-092 C1: a PIN in Thai digits passes the form and is sent to the server', async () => {
    const fetchMock = stubApi({ '/api/join': () => Response.json(joined) });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({ pin: '๑๒๓๔' });

    expect(await screen.findByText(/เข้าเกมแล้ว/)).toBeTruthy();
    expect(callsTo(fetchMock, '/api/join')).toHaveLength(1);
  });

  it('GEN-092 C3: Thai letters in the PIN say the keyboard may be Thai, without calling the server', async () => {
    const fetchMock = stubApi({ '/api/join': () => Response.json(joined) });

    render(<App apiBaseUrl="" />);
    fillAndSubmit({ pin: 'ๅ/-ภ' });

    expect(await screen.findByText(/แป้นพิมพ์อาจเป็นภาษาไทย/)).toBeTruthy();
    expect(screen.getByLabelText('PIN').getAttribute('aria-invalid')).toBe('true');
    expect(callsTo(fetchMock, '/api/join')).toHaveLength(0);
  });

  it('GEN-092 C4: the show button reveals the PIN and a second press hides it again', () => {
    stubApi({});
    render(<App apiBaseUrl="" />);
    const pin = screen.getByLabelText('PIN');
    fireEvent.change(pin, { target: { value: '๑๒๓๔' } });

    expect(pin.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'แสดง PIN' }));
    expect(pin.getAttribute('type')).toBe('text');
    expect((pin as HTMLInputElement).value).toBe('๑๒๓๔');
    fireEvent.click(screen.getByRole('button', { name: 'ซ่อน PIN' }));
    expect(pin.getAttribute('type')).toBe('password');
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
