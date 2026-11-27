// ISK-019: create the game with every setting (and the scenario) in one POST, and a lobby with no host where
// the game starts once everyone pressed [พร้อม].
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameView, RoomServerMessage } from '@isekai/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { CREATE_DRAFT_KEY, CreateGameForm } from '../src/CreateGameForm.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { SCREEN_VIEWS } from '../src/dev/screens.tsx';
import { SCENARIOS } from '../src/mock/scenarios.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

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
const bodyOf = (call: unknown[] | undefined) => JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;

/** Stands in for the browser WebSocket; the test plays the server. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    act(() => this.onopen?.());
  }
  receive(message: RoomServerMessage) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
}

const ME = 'm-nok';
function view(patch: Partial<GameView> = {}): GameView {
  return {
    id: 'g-1',
    name: 'เมืองก่อนอุกกาบาต',
    mode: 'online',
    humanGm: false,
    npcDialogue: 'high',
    tone: 'B',
    inviteCode: 'K7Q2MX',
    status: 'lobby',
    startedAt: null,
    you: { memberId: ME, role: 'player' },
    members: [
      { id: ME, name: 'นก', role: 'player', ready: false, hasCharacter: true },
      { id: 'm-bel', name: 'เบล', role: 'player', ready: true, hasCharacter: true },
      { id: 'm-ton', name: 'ต้น', role: 'player', ready: false, hasCharacter: true },
    ],
    players: { count: 3, min: 2, max: 6 },
    canEditScenario: false,
    startBlockers: [],
    memory: { enabled: false, sources: [] },
    closed: null,
    ...patch,
  };
}
const withMe = (game: GameView, ready: boolean): GameView => ({ ...game, members: game.members.map((m) => (m.id === ME ? { ...m, ready } : m)) });

const noop = () => {};
const lobby = (game: GameView, more: Partial<Parameters<typeof Lobby>[0]> = {}) =>
  render(<Lobby apiBaseUrl="" token="tok-abc" initial={game} onSessionLost={noop} pollMs={60_000} {...more} />);
const lobbySocket = () => {
  const socket = FakeSocket.all.at(-1)!;
  socket.open();
  return socket;
};
const readyButton = () => screen.getByRole('button', { name: /^(พร้อม|ยกเลิกพร้อม)$/ });

function fillCreate() {
  for (const [label, value] of [['Create code', 'ลับเฉพาะ'], ['ชื่อเกม', 'เมืองของ GM'], ['ชื่อผู้เล่นของคุณ', 'ต้น'], ['PIN ของคุณ', '1234']] as const) {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }
}
const submitCreate = () => fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมและรับโค้ด' }));
const created = (game: GameView) => ({ token: 'tok-new', expiresAt: '2026-12-22T12:00:00.000Z', member: { id: ME, gameId: game.id, name: 'นก' }, game });

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe('ISK-019 create game in one step', () => {
  it('C1: settings + an edited scenario go in one POST /api/games, then the lobby opens', async () => {
    const game = view({ humanGm: true, you: { memberId: ME, role: 'gm' }, members: [{ id: ME, name: 'ต้น', role: 'gm', ready: false, hasCharacter: false }], players: { count: 0, min: 2, max: 6 } });
    const fetchMock = stubApi({
      'POST /api/games': () => Response.json(created(game)),
      'GET /api/me': () => Response.json({ member: { id: ME, gameId: game.id, name: 'ต้น' } }),
      'GET /api/game': () => Response.json(game),
    });
    render(<App apiBaseUrl="" />);
    fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมใหม่' }));
    fillCreate();
    fireEvent.click(screen.getByLabelText(/มี GM คน/));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'บทพูดของ NPC' })).getByRole('radio', { name: /เยอะ/ }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'โทนภาษา' })).getByRole('radio', { name: /ขี้เล่น/ }));
    fireEvent.click(screen.getByRole('button', { name: 'แก้ scenario' }));
    const editor = await screen.findByRole('region', { name: 'แก้ scenario' });
    const first = within(editor).getAllByRole('group', { name: /^เหตุการณ์ / })[0]!;
    fireEvent.change(within(first).getByLabelText('หัวข้อ'), { target: { value: 'คาราวานมาถึง' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'กลับไปฟอร์ม' }));
    submitCreate();

    expect(await screen.findByRole('region', { name: 'ห้องรอ' })).toBeTruthy();
    const posts = callsTo(fetchMock, 'POST', '/api/games');
    expect(posts).toHaveLength(1);
    const sent = bodyOf(posts[0]);
    expect(sent).toMatchObject({ createCode: 'ลับเฉพาะ', gameName: 'เมืองของ GM', mode: 'online', humanGm: true, npcDialogue: 'high', tone: 'C', name: 'ต้น', pin: '1234' });
    expect((sent.scenario as { timeline: { title: string }[] }).timeline[0]!.title).toBe('คาราวานมาถึง');
  });

  it('C2: skipping the scenario sends no scenario; [ยกเลิก] before creating sends nothing', async () => {
    const fetchMock = stubApi({ 'POST /api/games': () => Response.json(created(view())) });
    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl="" onCreated={onCreated} onBack={noop} />);
    fillCreate();
    fireEvent.click(screen.getByLabelText(/มี GM คน/));
    submitCreate();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(bodyOf(callsTo(fetchMock, 'POST', '/api/games')[0])).not.toHaveProperty('scenario');
    cleanup();

    fetchMock.mockClear();
    const onBack = vi.fn();
    render(<CreateGameForm apiBaseUrl="" onCreated={onCreated} onBack={onBack} />);
    fillCreate();
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    expect(onBack).toHaveBeenCalled();
    expect(callsTo(fetchMock, 'POST', '/api/games')).toHaveLength(0);
    expect(sessionStorage.getItem(CREATE_DRAFT_KEY)).toBeNull();
  });

  it('C3: a half-filled form comes back after a reload (codes and PIN are not kept); a created game deletes the draft', async () => {
    stubApi({ 'POST /api/games': () => Response.json(created(view())) });
    render(<CreateGameForm apiBaseUrl="" onCreated={noop} onBack={noop} />);
    fillCreate();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'โทนภาษา' })).getByRole('radio', { name: /ขี้เล่น/ }));
    cleanup();

    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl="" onCreated={onCreated} onBack={noop} />);
    expect((screen.getByLabelText('ชื่อเกม') as HTMLInputElement).value).toBe('เมืองของ GM');
    expect((screen.getByLabelText('ชื่อผู้เล่นของคุณ') as HTMLInputElement).value).toBe('ต้น');
    expect((within(screen.getByRole('radiogroup', { name: 'โทนภาษา' })).getByRole('radio', { name: /ขี้เล่น/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Create code') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('PIN ของคุณ') as HTMLInputElement).value).toBe('');
    expect(sessionStorage.getItem(CREATE_DRAFT_KEY)).not.toMatch(/ลับเฉพาะ|1234/);

    fillCreate();
    submitCreate();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(sessionStorage.getItem(CREATE_DRAFT_KEY)).toBeNull();
  });

  it('C12: a 409 memory refusal or no network shows an error and keeps every value', async () => {
    let answer: () => Response | Promise<Response> = () => Response.json({ code: 'not_allowed', message: 'ใช้เกมนี้เป็นความทรงจำไม่ได้' }, { status: 409 });
    stubApi({ 'POST /api/games': () => answer() });
    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl="" onCreated={onCreated} onBack={noop} />);
    fillCreate();
    submitCreate();
    expect(await screen.findByText('ใช้เกมนี้เป็นความทรงจำไม่ได้')).toBeTruthy();
    expect((screen.getByLabelText('ชื่อเกม') as HTMLInputElement).value).toBe('เมืองของ GM');
    expect((screen.getByLabelText('PIN ของคุณ') as HTMLInputElement).value).toBe('1234');

    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    submitCreate();
    expect(await screen.findByText(/ติดต่อ server ไม่ได้/)).toBeTruthy();
    expect((screen.getByLabelText('ชื่อเกม') as HTMLInputElement).value).toBe('เมืองของ GM');
    expect(sessionStorage.getItem(CREATE_DRAFT_KEY)).toContain('เมืองของ GM');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('C12: sessionStorage throwing does not stop the form', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    stubApi({ 'POST /api/games': () => Response.json(created(view())) });
    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl="" onCreated={onCreated} onBack={noop} />);
    fillCreate();
    submitCreate();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('a refused scenario opens the scenario step with the message at its field', async () => {
    stubApi({
      'POST /api/games': () =>
        Response.json({ code: 'invalid_input', message: 'scenario ไม่ถูกต้อง', fields: { 'timeline.0.title': 'ห้ามว่าง' } }, { status: 400 }),
    });
    render(<CreateGameForm apiBaseUrl="" onCreated={noop} onBack={noop} />);
    fillCreate();
    fireEvent.click(screen.getByLabelText(/มี GM คน/));
    fireEvent.click(screen.getByRole('button', { name: 'แก้ scenario' }));
    fireEvent.click(screen.getByRole('button', { name: 'กลับไปฟอร์ม' }));
    submitCreate();
    const editor = await screen.findByRole('region', { name: 'แก้ scenario' });
    expect(within(within(editor).getAllByRole('group', { name: /^เหตุการณ์ / })[0]!).getByText('ห้ามว่าง')).toBeTruthy();
  });

  it('Q-028: a game with no Human GM has no scenario step (its players never see scenario content)', () => {
    stubApi({});
    render(<CreateGameForm apiBaseUrl="" onCreated={noop} onBack={noop} />);
    expect(screen.queryByRole('button', { name: 'แก้ scenario' })).toBeNull();
  });
});

describe('ISK-019 lobby with no host', () => {
  it('C4: no start, kick, new code, delete, settings or scenario edits, no owner / host label; settings read-only', () => {
    stubApi({});
    lobby(view());
    for (const name of [/เริ่มเกม/, /เตะ/, /ออกโค้ดใหม่/, /ลบเกม/, /แก้ scenario/, /แก้ตั้งค่า/]) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    const region = screen.getByRole('region', { name: 'ห้องรอ' });
    expect(region.textContent).not.toMatch(/เจ้าของเกม|host|โฮสต์/i);
    expect(region.textContent).toContain('บทพูดของ NPC: เยอะ');
    expect(region.textContent).toContain('โทนภาษา: ตำนานโบราณ ภาษาสูง');
  });

  it('C5: online 3 players, 1 ready: (1/3); a lobby_ready of another player makes it (2/3) with a ready mark', () => {
    stubApi({});
    lobby(view());
    expect(screen.getByText('รอทุกคนพร้อม (1/3)')).toBeTruthy();
    const socket = lobbySocket();
    expect(socket.sent[0]).toMatchObject({ type: 'hello', token: 'tok-abc', lobby: true });
    socket.receive({ type: 'lobby_ready', memberId: 'm-ton', ready: true });
    expect(screen.getByText('รอทุกคนพร้อม (2/3)')).toBeTruthy();
    const row = within(screen.getByRole('list', { name: 'สมาชิก' })).getByText('ต้น').closest('li')!;
    expect(within(row).getByText('พร้อม')).toBeTruthy();
  });

  it('C4 / (5): no page of the web names a game owner or host', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const named = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /เจ้าของเกม|โฮสต์/.test(readFileSync(join(src, f), 'utf8')));
    expect(named).toEqual([]);
  });

  it('C6: online with 1 player: waiting for at least 1 more', () => {
    stubApi({});
    lobby(view({ members: [view().members[0]!], players: { count: 1, min: 2, max: 6 } }));
    expect(screen.getByText('รอผู้เล่นอีกอย่างน้อย 1 คน')).toBeTruthy();
  });

  it('C7: [พร้อม] waits for the server, then is pressed as [ยกเลิกพร้อม]; a second press while sending sends nothing', async () => {
    let answer!: (r: Response) => void;
    const fetchMock = stubApi({ 'POST /api/game/ready': () => new Promise<Response>((resolve) => (answer = resolve)) });
    lobby(view());
    const button = readyButton();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    fireEvent.click(readyButton());
    expect(callsTo(fetchMock, 'POST', '/api/game/ready')).toHaveLength(1);
    expect(bodyOf(callsTo(fetchMock, 'POST', '/api/game/ready')[0])).toEqual({ ready: true });
    await act(async () => answer(Response.json(withMe(view(), true))));
    const pressed = await screen.findByRole('button', { name: 'ยกเลิกพร้อม' });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('รอทุกคนพร้อม (2/3)')).toBeTruthy();
  });

  it('C8: lobby_start_blocked shows the reason and [ลองเริ่มอีกครั้ง] sends ready true', async () => {
    const fetchMock = stubApi({ 'POST /api/game/ready': () => Response.json(withMe(view(), true)) });
    lobby(withMe(view(), true));
    lobbySocket().receive({ type: 'lobby_start_blocked', reason: 'ยังไม่ได้ตั้งค่า AI' });
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('ยังไม่ได้ตั้งค่า AI');
    fireEvent.click(within(banner).getByRole('button', { name: 'ลองเริ่มอีกครั้ง' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/game/ready')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, 'POST', '/api/game/ready')[0])).toEqual({ ready: true });
  });

  it('C9: once the game starts (same event as before: GET /api/game) everyone goes on as before', async () => {
    const started = view({ status: 'started', startedAt: '2026-11-24T12:00:00.000Z' });
    stubApi({ 'GET /api/game': () => Response.json(started) });
    lobby(view(), { pollMs: 20 });
    expect(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(พร้อม|ยกเลิกพร้อม)$/ })).toBeNull();
  });

  it('C11: a 503 or no network leaves the button as it was, with a message', async () => {
    let answer: () => Response | Promise<Response> = () => Response.json({ code: 'ai_not_ready', message: 'ยังไม่ได้ตั้งค่า AI' }, { status: 503 });
    stubApi({ 'POST /api/game/ready': () => answer() });
    lobby(view());
    fireEvent.click(readyButton());
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('ยังไม่ได้ตั้งค่า AI');
    expect(readyButton().textContent).toBe('พร้อม');
    expect(readyButton().getAttribute('aria-pressed')).toBe('false');

    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    fireEvent.click(readyButton());
    expect(await screen.findByText(/ติดต่อ server ไม่ได้/)).toBeTruthy();
    expect(readyButton().textContent).toBe('พร้อม');
  });

  it('C13: after a reload the ready state comes from members[].ready; single says press ready to start', async () => {
    stubApi({ 'GET /api/game': () => Response.json(withMe(view(), true)) });
    render(<Lobby apiBaseUrl="" token="tok-abc" onSessionLost={noop} pollMs={60_000} />);
    expect((await screen.findByRole('button', { name: 'ยกเลิกพร้อม' })).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('รอทุกคนพร้อม (2/3)')).toBeTruthy();
    cleanup();

    lobby(view({ mode: 'single', members: [view().members[0]!], players: { count: 1, min: 1, max: 1 } }));
    expect(screen.getByText('กดพร้อมเพื่อเริ่มเกม')).toBeTruthy();
  });

  it('the Human GM has no ready button and reads the scenario only', () => {
    stubApi({});
    lobby(view({ humanGm: true, you: { memberId: 'm-gm', role: 'gm' }, members: [...view().members, { id: 'm-gm', name: 'จีเอ็ม', role: 'gm', ready: false, hasCharacter: false }] }));
    expect(screen.queryByRole('button', { name: /^(พร้อม|ยกเลิกพร้อม)$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'ดู scenario' })).toBeTruthy();
  });
});

describe('ISK-019 C10 390 px and the gallery', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pregame.css'), 'utf8');

  it('the ready button and the blocked bar are 44 px targets that wrap', () => {
    expect(css).toMatch(/\.lobby__ready[^{]*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.lobby__blocked[^{]*\{[^}]*flex-wrap:\s*wrap/);
    for (const file of ['Lobby.tsx', 'CreateGameForm.tsx', 'ScenarioEditor.tsx', 'pregame.css']) {
      expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', file), 'utf8')).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
    }
  });

  it('the gallery has every create-game and lobby state', () => {
    const ids = (screenId: string) => SCENARIOS.filter((s) => s.screens.includes(screenId as never)).map((s) => s.id);
    expect(ids('create-game')).toEqual(expect.arrayContaining(['guest', 'create-filled', 'create-error']));
    expect(ids('lobby')).toEqual(expect.arrayContaining(['lobby-alone', 'lobby-waiting', 'lobby', 'lobby-start-blocked', 'lobby-single']));
    expect(SCREEN_VIEWS['create-game'].render).toBeTruthy();
  });

  it('the filled create-game frame shows its draft; the empty one stays empty', () => {
    stubApi({});
    render(<>{SCREEN_VIEWS['create-game'].render!({ baseUrl: '', token: '', scenario: 'create-filled' })}</>);
    expect((screen.getByLabelText('ชื่อเกม') as HTMLInputElement).value).not.toBe('');
    expect(screen.getByText(/Scenario: แก้แล้ว/)).toBeTruthy();
    cleanup();
    render(<>{SCREEN_VIEWS['create-game'].render!({ baseUrl: '', token: '', scenario: 'guest' })}</>);
    expect((screen.getByLabelText('ชื่อเกม') as HTMLInputElement).value).toBe('');
  });
});
