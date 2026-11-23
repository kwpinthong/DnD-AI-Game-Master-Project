// ISK-002: players learn that the server owner closed their game. C4 game_closed in Play, C5 the lobby /
// character page learn it from the poll (Q-387 A), C6 opening a closed game again, C7 the end page + history.
import { GameLogResponse, type GameView, type RoomServerMessage, type RoomState } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { GameHistory, GameLog } from '../src/GameHistory.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { KNOWN_TOKENS_KEY, TOKEN_KEY } from '../src/session.ts';

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.drop(1000);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    act(() => this.onopen?.());
  }
  receive(message: RoomServerMessage) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  drop(code = 1006) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    act(() => this.onclose?.({ code }));
  }
}

const me = { id: 'm-lin', gameId: 'g-1', name: 'นก' };
const CLOSED_LOG = GameLogResponse.parse(CONTRACT_FIXTURES.GameLogResponse.find((l) => l.game.closedEarly)!);
const ENDED_LOG = GameLogResponse.parse(CONTRACT_FIXTURES.GameLogResponse[1]);

function gameView(patch: Partial<GameView> = {}): GameView {
  return {
    id: 'g-1',
    name: 'เมืองก่อนอุกกาบาต',
    mode: 'online',
    humanGm: false,
    inviteCode: 'K7Q2MX',
    status: 'started',
    startedAt: '2026-11-22T12:00:00.000Z',
    you: { memberId: me.id, role: 'player', isOwner: true },
    members: [
      { id: me.id, name: 'นก', role: 'player', isOwner: true, hasCharacter: true },
      { id: 'm-bee', name: 'บี', role: 'player', isOwner: false, hasCharacter: true },
    ],
    players: { count: 2, min: 2, max: 6 },
    canEditScenario: false,
    startBlockers: [],
    ...patch,
  };
}

const roomState = (): RoomState => ({
  type: 'room',
  gameId: 'g-1',
  mode: 'online',
  day: 4,
  phase: 'EOSORIA',
  turn: 1,
  status: 'collecting',
  weather: null,
  members: [{ memberId: me.id, name: 'นก', role: 'player', online: true, submitted: false }],
  submittedCount: 0,
  you: { memberId: me.id, role: 'player', place: { id: 'market', name: 'ลานตลาด' }, lock: null, secretUsed: false, drowsy: false, action: null, allies: [] },
  gmStatus: null,
});

/** GET /api/game answers `games()` (it may change between calls); the play data, the log and the rest as a server would. */
function server(games: () => GameView) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${new URL(url, 'http://x').pathname}`;
      calls.push(key);
      if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
      if (key === 'GET /api/me') return Response.json({ member: me });
      if (key === 'GET /api/game') return Response.json(games());
      if (key === 'GET /api/game/log') return Response.json(CLOSED_LOG);
      if (key === 'GET /api/game/surroundings') return Response.json({ view: 'player', you: null, place: null, people: [], npcs: [] });
      if (key === 'GET /api/game/companions') return Response.json({ companions: [] });
      if (key === 'GET /api/game/inventory') return Response.json({ inventory: { skills: [], items: [], discoveries: [] } });
      if (key === 'GET /api/game/character') return Response.json({ character: null });
      return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
    }),
  );
  return calls;
}

const modal = (timeout = 1000) => screen.findByRole('alertdialog', { name: 'เกมถูกปิดโดยผู้ดูแล' }, { timeout });

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('C4 game_closed while playing', () => {
  it('a modal that cannot be closed, the reason, no action box; [ไปหน้าสรุป] opens this game end page', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-abc');
    server(() => gameView());
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    const socket = await waitFor(() => FakeSocket.all.at(-1)!);
    socket.open();
    socket.receive(roomState());
    socket.receive({ type: 'ready', lastSeq: 0 });
    expect(await screen.findByLabelText(/^พิมพ์สิ่งที่จะทำ/)).toBeTruthy();

    socket.receive({ type: 'game_closed', reason: 'ทดสอบระบบ', hasSummary: true });
    const dialog = await modal();
    expect(dialog.textContent).toContain('ทดสอบระบบ');
    expect(screen.queryByLabelText(/^พิมพ์สิ่งที่จะทำ/)).toBeNull();
    // only the way to the summary: no close button, Escape does nothing
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['ไปหน้าสรุป']);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: 'เกมถูกปิดโดยผู้ดูแล' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'ไปหน้าสรุป' }));
    expect(await screen.findByRole('region', { name: `สรุปเกม ${CLOSED_LOG.game.name}` })).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('C5 closed in the lobby or on the character page (no summary)', () => {
  const lobbyGame = gameView({ status: 'lobby', startedAt: null, members: [{ id: me.id, name: 'นก', role: 'player', isOwner: false, hasCharacter: false }] });
  const closedLobby = { ...lobbyGame, closed: { reason: null, hasSummary: false } };

  it('lobby: the poll brings the close; no reason line, [กลับหน้าแรก] goes to our game list', { timeout: 10_000 }, async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-abc');
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-abc']));
    let closed = false;
    server(() => (closed ? closedLobby : lobbyGame));
    render(<App apiBaseUrl="" />);
    expect(await screen.findByRole('list', { name: 'สมาชิก' })).toBeTruthy();
    closed = true;
    // the app's own poll period (3 s)
    const dialog = await modal(5000);
    expect(dialog.textContent).not.toContain('เหตุผล');
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['กลับหน้าแรก']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'กลับหน้าแรก' }));
    expect(await screen.findByRole('region', { name: 'รายการเกม' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('character page: the lobby keeps asking while it is open and shows the same modal', async () => {
    let closed = false;
    server(() => (closed ? closedLobby : lobbyGame));
    render(<Lobby apiBaseUrl="" token="tok-abc" onSessionLost={() => {}} pollMs={50} />);
    fireEvent.click(await screen.findByRole('button', { name: 'สร้างตัวละคร' }));
    expect(await screen.findByLabelText('ชื่อจริง')).toBeTruthy();
    closed = true;
    const dialog = await modal();
    expect(within(dialog).getByRole('button', { name: 'กลับหน้าแรก' })).toBeTruthy();
    expect(screen.queryByLabelText('ชื่อจริง')).toBeNull();
  });

  it('setup (started, not in the room yet): the lobby also keeps asking', async () => {
    let closed = false;
    const setup = gameView();
    server(() => (closed ? { ...setup, closed: { reason: 'ทดสอบระบบ', hasSummary: false } } : setup));
    render(<Lobby apiBaseUrl="" token="tok-abc" onSessionLost={() => {}} pollMs={50} />);
    expect(await screen.findByRole('button', { name: 'เข้าห้องเล่น' })).toBeTruthy();
    closed = true;
    expect((await modal()).textContent).toContain('ทดสอบระบบ');
  });

  it('a socket told game_closed then closed with 4010 does not reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      localStorage.setItem(TOKEN_KEY, 'tok-abc');
      server(() => gameView());
      render(<App apiBaseUrl="" />);
      fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
      const socket = await waitFor(() => FakeSocket.all.at(-1)!);
      socket.open();
      socket.receive({ type: 'game_closed', reason: null, hasSummary: false });
      socket.drop(4010);
      expect(await modal()).toBeTruthy();
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(FakeSocket.all).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('C6 opening a closed game again (the event was missed)', () => {
  it('the same modal shows as the page loads', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-abc');
    server(() => gameView({ closed: { reason: 'ทดสอบระบบ', hasSummary: true } }));
    render(<App apiBaseUrl="" />);
    const dialog = await modal();
    expect(dialog.textContent).toContain('ทดสอบระบบ');
    expect(within(dialog).getByRole('button', { name: 'ไปหน้าสรุป' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'เข้าห้องเล่น' })).toBeNull();
  });
});

describe('C7 the end page and the history', () => {
  it('closedEarly: the ปิดก่อนกำหนด badge and the reason instead of the ending block', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 })));
    render(<GameLog log={CLOSED_LOG} onBack={() => {}} />);
    expect(screen.getByText('ปิดก่อนกำหนด')).toBeTruthy();
    expect(screen.getByText(/ทดสอบระบบ/)).toBeTruthy();
    expect(document.querySelector('.end-scene__path')).toBeNull();
    expect(screen.queryByText('ไม่มีบันทึกตอนจบ')).toBeNull();
    // the fates (karma) are there like a normal end (Q-388)
    expect(screen.getAllByText('กรรม').length).toBeGreaterThan(0);
    expect(screen.getByText(/ปิดโดยผู้ดูแล/)).toBeTruthy();
  });

  it('closedEarly with no reason: the badge only, no empty block', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 })));
    render(<GameLog log={{ ...CLOSED_LOG, game: { ...CLOSED_LOG.game, closeReason: null } }} onBack={() => {}} />);
    expect(screen.getByText('ปิดก่อนกำหนด')).toBeTruthy();
    expect(screen.queryByText(/เหตุผล/)).toBeNull();
  });

  it('a normal end has no badge', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 })));
    render(<GameLog log={ENDED_LOG} onBack={() => {}} />);
    expect(screen.queryByText('ปิดก่อนกำหนด')).toBeNull();
    expect(document.querySelector('.end-scene__path')).toBeTruthy();
  });

  it('the game list says ปิดโดยผู้ดูแล', async () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-closed']));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(CLOSED_LOG)));
    render(<GameHistory apiBaseUrl="" onClose={() => {}} />);
    const list = await screen.findByRole('list', { name: 'เกมของฉัน' });
    expect(within(list).getByRole('listitem').textContent).toContain('ปิดโดยผู้ดูแล');
  });
});
