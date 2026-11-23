import type { GameView } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { TOKEN_KEY } from '../src/session.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Routes are "METHOD /path"; the first matching suffix wins. */
function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
    const method = init?.method ?? 'GET';
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && url.endsWith(p!);
    });
    if (!key) throw new Error(`unexpected request ${method} ${url}`);
    return routes[key]!(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof stubApi>, method: string, path: string) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith(path) && (init?.method ?? 'GET') === method);

const owner = { id: 'm-owner', gameId: 'g-1', name: 'นก' };

function view(patch: Partial<GameView> = {}): GameView {
  return {
    id: 'g-1',
    name: 'เมืองก่อนอุกกาบาต',
    mode: 'online',
    humanGm: false,
    inviteCode: 'K7Q2MX',
    status: 'lobby',
    startedAt: null,
    you: { memberId: owner.id, role: 'player' },
    members: [
      { id: owner.id, name: 'นก', role: 'player', ready: false, hasCharacter: true },
      { id: 'm-bel', name: 'เบล', role: 'player', ready: false, hasCharacter: false },
    ],
    players: { count: 2, min: 2, max: 6 },
    canEditScenario: false,
    startBlockers: ['ยังไม่สร้างตัวละคร: เบล'],
    ...patch,
  };
}

const created = (game: GameView) => ({ token: 'tok-new', expiresAt: '2026-12-22T12:00:00.000Z', member: owner, game });

function openCreateForm() {
  fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมใหม่' }));
}

function fillCreate(values: { createCode?: string; gameName?: string; name?: string; pin?: string } = {}) {
  const { createCode = 'ลับเฉพาะ', gameName = 'เมืองก่อนอุกกาบาต', name = 'นก', pin = '1234' } = values;
  // GEN-090 C2: a field tells its error once the creator leaves it, and the button is off while one is wrong.
  for (const [label, value] of [['Create code', createCode], ['ชื่อเกม', gameName], ['ชื่อผู้เล่นของคุณ', name], ['PIN ของคุณ', pin]] as const) {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }
}

const submitCreate = () => fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมและรับโค้ด' }));

/** Opens the page logged in as the member of `game` (kept token + GET /api/me + GET /api/game). */
function loggedIn(game: GameView, more: Record<string, Handler> = {}) {
  localStorage.setItem(TOKEN_KEY, 'tok-abc');
  const me = game.members.find((m) => m.id === game.you.memberId)!;
  return stubApi({
    'GET /api/me': () => Response.json({ member: { id: me.id, gameId: game.id, name: me.name } }),
    'GET /api/game': () => Response.json(game),
    ...more,
  });
}

describe('Create game + Lobby (GEN-025)', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('C1: creates an Online game with a Human GM and opens the lobby with the invite code; the creator is GM', async () => {
    const game = view({
      humanGm: true,
      you: { memberId: owner.id, role: 'gm' },
      members: [{ id: owner.id, name: 'นก', role: 'gm', ready: false, hasCharacter: false }],
      players: { count: 0, min: 2, max: 6 },
      startBlockers: ['ขาดผู้เล่นอีก 2 คน (Online ต้องมีผู้เล่นอย่างน้อย 2 คน)'],
    });
    const fetchMock = stubApi({
      'POST /api/games': () => Response.json(created(game)),
      'GET /api/me': () => Response.json({ member: owner }),
      'GET /api/game': () => Response.json(game),
    });

    render(<App apiBaseUrl="" />);
    openCreateForm();
    fillCreate();
    fireEvent.click(screen.getByLabelText(/มี GM คน/));
    submitCreate();

    expect(await screen.findByText('K7Q-2MX')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', '/api/games');
    expect(JSON.parse(String(call![1]?.body))).toEqual({
      createCode: 'ลับเฉพาะ',
      gameName: 'เมืองก่อนอุกกาบาต',
      mode: 'online',
      humanGm: true,
      npcDialogue: 'normal',
      name: 'นก',
      pin: '1234',
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-new');
    const list = screen.getByRole('list', { name: 'สมาชิก' });
    expect(within(list).getByText(/GM/)).toBeTruthy();
    expect(screen.getByText('ผู้เล่น 0/6')).toBeTruthy();
  });

  it('GEN-092 C1/C3: a Thai-digit PIN is sent; Thai letters are stopped with the keyboard hint', async () => {
    const game = view();
    const fetchMock = stubApi({
      'POST /api/games': () => Response.json(created(game)),
      'GET /api/game': () => Response.json(game),
    });

    render(<App apiBaseUrl="" />);
    openCreateForm();
    fillCreate({ pin: 'ๅ/-ภ' });
    submitCreate();
    expect(await screen.findByText(/แป้นพิมพ์อาจเป็นภาษาไทย/)).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', '/api/games')).toHaveLength(0);

    fillCreate({ pin: '๑๒๓๔' });
    submitCreate();
    expect(await screen.findByText('K7Q-2MX')).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', '/api/games')).toHaveLength(1);
  });

  it('GEN-092 C4/C7: the creator PIN asks for a new password and can be shown and hidden', () => {
    stubApi({});
    render(<App apiBaseUrl="" />);
    openCreateForm();
    const pin = screen.getByLabelText('PIN ของคุณ');

    expect(pin.getAttribute('autocomplete')).toBe('new-password');
    expect(pin.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'แสดง PIN' }));
    expect(pin.getAttribute('type')).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'ซ่อน PIN' }));
    expect(pin.getAttribute('type')).toBe('password');
  });

  it('C2: Single hides the Human GM choice and sends humanGm false', async () => {
    const game = view({ mode: 'single', players: { count: 1, min: 1, max: 1 }, members: [view().members[0]!] });
    const fetchMock = stubApi({
      'POST /api/games': () => Response.json(created(game)),
      'GET /api/game': () => Response.json(game),
    });

    render(<App apiBaseUrl="" />);
    openCreateForm();
    fillCreate();
    fireEvent.click(screen.getByLabelText(/มี GM คน/));
    fireEvent.click(screen.getByLabelText(/เล่นคนเดียว/));
    expect(screen.queryByLabelText(/มี GM คน/)).toBeNull();
    submitCreate();

    expect(await screen.findByText('ผู้เล่น 1/1')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', '/api/games');
    expect(JSON.parse(String(call![1]?.body))).toMatchObject({ mode: 'single', humanGm: false });
  });

  it('C3: a wrong create code is shown at the create code field and nothing is kept', async () => {
    stubApi({
      'POST /api/games': () => Response.json({ code: 'wrong_create_code', message: 'create code ไม่ถูกต้อง' }, { status: 403 }),
    });

    render(<App apiBaseUrl="" />);
    openCreateForm();
    fillCreate({ createCode: 'เดา' });
    submitCreate();

    expect(await screen.findByText('create code ไม่ถูกต้อง')).toBeTruthy();
    expect(screen.getByLabelText('Create code').getAttribute('aria-invalid')).toBe('true');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('C3: an empty create code is flagged without calling the server', async () => {
    const fetchMock = stubApi({});

    render(<App apiBaseUrl="" />);
    openCreateForm();
    fillCreate({ createCode: '' });
    submitCreate();

    expect(await screen.findByText('กรุณาใส่ create code')).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', '/api/games')).toHaveLength(0);
  });

  it('C5: the owner sees why the game cannot start yet and the start button is off', async () => {
    loggedIn(view());

    render(<App apiBaseUrl="" />);

    expect(await screen.findByText('ยังไม่สร้างตัวละคร: เบล')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'เริ่มเกม' }) as HTMLButtonElement).disabled).toBe(true);
    const list = screen.getByRole('list', { name: 'สมาชิก' });
    expect(within(list).getByText(/เบล/).closest('li')!.textContent).toContain('ยังไม่สร้างตัวละคร');
  });

  it('C5: the owner starts the game once nothing blocks it', async () => {
    const ready = view({ startBlockers: [] });
    const fetchMock = loggedIn(ready, {
      'POST /api/game/start': () => Response.json({ ...ready, status: 'started', startedAt: '2026-11-22T12:00:00.000Z' }),
    });

    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เริ่มเกม' }));

    expect(await screen.findByText(/เกมเริ่มแล้ว/)).toBeTruthy();
    expect(new Headers(callsTo(fetchMock, 'POST', '/api/game/start')[0]![1]?.headers).get('authorization')).toBe('Bearer tok-abc');
    expect(screen.queryByRole('button', { name: /เตะ/ })).toBeNull();
  });

  it('C5: reasons the server gives when the start is refused are shown', async () => {
    const ready = view({ startBlockers: [] });
    loggedIn(ready, {
      'POST /api/game/start': () =>
        Response.json(
          { code: 'cannot_start', message: 'ยังเริ่มเกมไม่ได้', reasons: ['ขาดผู้เล่นอีก 1 คน (Online ต้องมีผู้เล่นอย่างน้อย 2 คน)'] },
          { status: 409 },
        ),
    });

    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เริ่มเกม' }));

    expect(await screen.findByText('ขาดผู้เล่นอีก 1 คน (Online ต้องมีผู้เล่นอย่างน้อย 2 คน)')).toBeTruthy();
  });

  it('C6: the owner gets a new invite code and the lobby shows it', async () => {
    const fetchMock = loggedIn(view(), { 'POST /api/game/invite-code': () => Response.json(view({ inviteCode: 'ZX9PQR' })) });

    render(<App apiBaseUrl="" />);
    expect(await screen.findByText('K7Q-2MX')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ออกโค้ดใหม่' }));

    expect(await screen.findByText('ZX9-PQR')).toBeTruthy();
    expect(screen.queryByText('K7Q-2MX')).toBeNull();
    expect(callsTo(fetchMock, 'POST', '/api/game/invite-code')).toHaveLength(1);
  });

  it('C7: the owner kicks a member with DELETE and the member leaves the list', async () => {
    const after = view({ members: [view().members[0]!], players: { count: 1, min: 2, max: 6 } });
    const fetchMock = loggedIn(view(), { 'DELETE /api/game/members/m-bel': () => Response.json(after) });

    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เตะ เบล' }));

    await waitFor(() => expect(within(screen.getByRole('list', { name: 'สมาชิก' })).queryByText(/เบล/)).toBeNull());
    const [call] = callsTo(fetchMock, 'DELETE', '/api/game/members/m-bel');
    expect(new Headers(call![1]?.headers).get('authorization')).toBe('Bearer tok-abc');
    expect(screen.queryByRole('button', { name: 'เตะ นก' })).toBeNull();
  });

  it('GEN-112 C6: deleting the game is a separate button; it needs the game name typed, then goes back to the join form', async () => {
    const fetchMock = loggedIn(view(), { 'DELETE /api/game': () => new Response(null, { status: 204 }) });

    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'ลบเกม' }));
    const confirm = screen.getByRole('button', { name: 'ยืนยันลบเกม' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(callsTo(fetchMock, 'DELETE', '/api/game')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('พิมพ์ชื่อเกมเพื่อยืนยัน'), { target: { value: 'เมืองก่อนอุกกาบาต' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    expect(await screen.findByLabelText('PIN')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'DELETE', '/api/game');
    expect(JSON.parse(String(call![1]?.body))).toEqual({ confirmName: 'เมืองก่อนอุกกาบาต' });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('GEN-112 C6: a member who is not the owner has no delete button', async () => {
    loggedIn(view({ you: { memberId: 'm-bel', role: 'player' } }));
    render(<App apiBaseUrl="" />);
    expect(await screen.findByText('K7Q-2MX')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ลบเกม' })).toBeNull();
  });

  it('C7: a member who is not the owner sees no kick, new code or start controls', async () => {
    loggedIn(view({ you: { memberId: 'm-bel', role: 'player' } }));

    render(<App apiBaseUrl="" />);

    expect(await screen.findByText('K7Q-2MX')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /เตะ/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ออกโค้ดใหม่' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'เริ่มเกม' })).toBeNull();
  });

  it('C7: a kicked member (session refused) is sent back to the join form and the token is forgotten', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-abc');
    stubApi({
      'GET /api/me': () => Response.json({ member: { id: 'm-bel', gameId: 'g-1', name: 'เบล' } }),
      'GET /api/game': () => Response.json({ code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' }, { status: 401 }),
    });

    render(<App apiBaseUrl="" />);

    expect(await screen.findByLabelText('PIN')).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBeNull());
  });
});
