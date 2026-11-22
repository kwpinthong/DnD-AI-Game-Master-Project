import type { GameView, RoomEntry, RoomServerMessage, RoomState } from '@isekai/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { roomSocketUrl } from '../src/room-api.ts';
import { TOKEN_KEY } from '../src/session.ts';

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
  // --- server side ---
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

function roomState(patch: Partial<RoomState> = {}, you: Partial<RoomState['you']> = {}): RoomState {
  return {
    type: 'room',
    gameId: 'g-1',
    mode: 'online',
    day: 1,
    phase: 'EOSORIA',
    turn: 1,
    status: 'collecting',
    members: [
      { memberId: me.id, name: 'นก', role: 'player', online: true, submitted: false },
      { memberId: 'm-bee', name: 'บี', role: 'player', online: false, submitted: false },
    ],
    you: { memberId: me.id, role: 'player', place: { id: 'market', name: 'ลานตลาด' }, lock: null, secretUsed: false, drowsy: false, action: null, allies: [], ...you },
    ...patch,
  };
}

const entry = (seq: number, kind: RoomEntry['kind'], text: string): RoomEntry => ({
  seq,
  kind,
  day: 1,
  phase: 'EOSORIA',
  turn: 1,
  place: kind === 'feed' ? { id: 'market', name: 'ลานตลาด' } : null,
  text,
});

function loggedIn(game: GameView, more: Record<string, () => Response> = {}) {
  localStorage.setItem(TOKEN_KEY, 'tok-abc');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${new URL(url, 'http://x').pathname}`;
      if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
      if (key === 'GET /api/me') return Response.json({ member: me });
      if (key === 'GET /api/game') return Response.json(game);
      const handler = more[key];
      if (!handler) throw new Error(`unexpected request ${key}`);
      return handler();
    }),
  );
}

/** Opens the page, goes to the play room and lets the fake server accept the socket. */
async function enterRoom(game = gameView()): Promise<FakeSocket> {
  loggedIn(game);
  render(<App apiBaseUrl="" />);
  fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
  const socket = await waitFor(() => {
    const s = FakeSocket.all.at(-1);
    if (!s) throw new Error('no socket yet');
    return s;
  });
  socket.open();
  return socket;
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('GEN-056 play room (web)', () => {
  it('the socket URL follows the API base URL (same origin when empty) and carries no token', () => {
    expect(roomSocketUrl('', 'http://localhost:5173/lobby?x=1')).toBe('ws://localhost:5173/api/game/room');
    expect(roomSocketUrl('https://isekai.up.railway.app')).toBe('wss://isekai.up.railway.app/api/game/room');
  });

  it('C1: entering sends hello with the token in the message, then shows who is online', async () => {
    const socket = await enterRoom();
    expect(socket.url).not.toContain('tok-abc');
    expect(socket.sent[0]).toEqual({ type: 'hello', token: 'tok-abc', afterSeq: 0 });
    socket.receive(roomState());
    socket.receive({ type: 'ready', lastSeq: 0 });
    const list = screen.getByRole('list', { name: 'ผู้เล่นในห้อง' });
    expect(within(list).getByText(/นก \(คุณ\) — ออนไลน์/)).toBeTruthy();
    expect(within(list).getByText(/บี — ออฟไลน์/)).toBeTruthy();
    expect(screen.getByText('คุณอยู่ที่: ลานตลาด')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'การเชื่อมต่อห้อง' }).textContent).toBe('เชื่อมต่อแล้ว');
  });

  it('C2: without a character the lobby button opens character creation, and so does the server saying no_character', async () => {
    loggedIn(gameView({ members: [{ id: me.id, name: 'นก', role: 'player', isOwner: true, hasCharacter: false }] }), {
      'GET /api/game/character': () => Response.json({ character: null }),
    });
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    expect(await screen.findByLabelText('ชื่อจริง')).toBeTruthy();
    expect(FakeSocket.all).toEqual([]);
    cleanup();

    loggedIn(gameView(), {
      'GET /api/game/character': () => Response.json({ character: null }),
    });
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    const socket = await waitFor(() => FakeSocket.all.at(-1)!);
    socket.open();
    socket.receive({ type: 'error', code: 'no_character', message: 'ต้องสร้างตัวละครก่อนเข้าห้องเล่น' });
    expect(await screen.findByLabelText('ชื่อจริง')).toBeTruthy();
  });

  it('C3: other players show only ส่งแล้ว; your own action is shown back to you', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ members: [roomState().members[0]!, { memberId: 'm-bee', name: 'บี', role: 'player', online: true, submitted: true }] }));
    expect(screen.getByText(/บี — ออนไลน์ · ส่งแล้ว/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('action ของคุณ'), { target: { value: 'แอบตามชายเสื้อคลุมดำ' } });
    fireEvent.click(screen.getByLabelText(/^Secret/));
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'action', text: 'แอบตามชายเสื้อคลุมดำ', visibility: 'secret', rest: false });
    socket.receive({ type: 'action_accepted' });
    socket.receive(roomState({}, { action: { text: 'แอบตามชายเสื้อคลุมดำ', visibility: 'secret', rest: false } }));
    expect(screen.getByText(/ส่งแล้ว \(Secret\): แอบตามชายเสื้อคลุมดำ/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ส่งแทนของเดิม' })).toBeTruthy();
  });

  it('C4 / C8: feed and private narration are shown in separate lists', async () => {
    const socket = await enterRoom();
    socket.receive({ type: 'entry', entry: entry(1, 'feed', 'ชายร่างสูงล้มแผงผลไม้') });
    socket.receive({ type: 'entry', entry: entry(2, 'narration', 'คุณเห็นรอยเท้าใต้โต๊ะ') });
    socket.receive(roomState());
    const feed = screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' });
    const mine = screen.getByRole('region', { name: 'สิ่งที่คุณรู้คนเดียว' });
    expect(within(feed).getByText('ชายร่างสูงล้มแผงผลไม้')).toBeTruthy();
    expect(within(feed).getByText('วันที่ 1 · EOSORIA (เช้า 06:00-11:59) · เทิร์น 1/2 · ลานตลาด')).toBeTruthy();
    expect(within(feed).queryByText('คุณเห็นรอยเท้าใต้โต๊ะ')).toBeNull();
    expect(within(mine).getByText('คุณเห็นรอยเท้าใต้โต๊ะ')).toBeTruthy();
  });

  it('C5: an empty or too long action is stopped with a reason; a server refusal and a lock are shown', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    const sentBefore = socket.sent.length;
    fireEvent.change(screen.getByLabelText('action ของคุณ'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(screen.getByRole('alert').textContent).toBe('พิมพ์ action ก่อนส่ง');
    fireEvent.change(screen.getByLabelText('action ของคุณ'), { target: { value: 'ก'.repeat(1001) } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(screen.getByRole('alert').textContent).toMatch(/ไม่เกิน 1000/);
    expect(socket.sent.length).toBe(sentBefore);

    fireEvent.change(screen.getByLabelText('action ของคุณ'), { target: { value: 'เดินไปตลาด' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    socket.receive({ type: 'action_rejected', code: 'resolving', message: 'phase นี้ปิดรับ action แล้ว กำลังสรุปผล รอ phase ถัดไป' });
    expect(screen.getByRole('alert').textContent).toMatch(/ปิดรับ/);

    socket.receive(roomState({}, { lock: { code: 'exhausted', message: 'ตัวละครหมดแรง (Stamina 0) phase นี้ต้องนอนพัก ส่ง action ไม่ได้' } }));
    expect(screen.getByRole('note').textContent).toMatch(/หมดแรง/);
    expect((screen.getByLabelText('action ของคุณ') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'ส่ง action' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('C6: after a drop it reconnects with the last seq it has and shows no entry twice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = await enterRoom();
    first.receive({ type: 'entry', entry: entry(3, 'feed', 'ฟีดหนึ่ง') });
    first.receive({ type: 'entry', entry: entry(5, 'narration', 'เล่าหนึ่ง') });
    first.receive(roomState());
    first.drop();
    expect(screen.getByRole('status', { name: 'การเชื่อมต่อห้อง' }).textContent).toMatch(/กำลังต่อใหม่/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    const second = FakeSocket.all.at(-1)!;
    expect(second).not.toBe(first);
    second.open();
    expect(second.sent[0]).toEqual({ type: 'hello', token: 'tok-abc', afterSeq: 5 });
    // A repeat of what the tab has is ignored; the missed one is added.
    second.receive({ type: 'entry', entry: entry(5, 'narration', 'เล่าหนึ่ง') });
    second.receive({ type: 'entry', entry: entry(8, 'feed', 'ฟีดสอง') });
    second.receive(roomState());
    second.receive({ type: 'ready', lastSeq: 8 });
    expect(screen.getAllByText('เล่าหนึ่ง')).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('ฟีดหนึ่ง'),
      expect.stringContaining('ฟีดสอง'),
    ]);
    expect(screen.getByRole('status', { name: 'การเชื่อมต่อห้อง' }).textContent).toBe('เชื่อมต่อแล้ว');
  });

  it('GEN-067 C4 / C6: Whisper goes to the chosen ally by ref; sent and received Whispers are listed apart', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({}, { allies: [{ ref: 'ref-darin', name: 'ดาริน' }] }));

    const form = screen.getByRole('form', { name: 'ส่ง Whisper' });
    fireEvent.change(within(form).getByLabelText('ถึง'), { target: { value: 'ref-darin' } });
    fireEvent.change(within(form).getByLabelText('ข้อความ Whisper'), { target: { value: 'คืนนี้เจอกันหลังวิหาร' } });
    fireEvent.click(within(form).getByRole('button', { name: 'ส่ง Whisper' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'whisper', to: 'ref-darin', text: 'คืนนี้เจอกันหลังวิหาร' });

    socket.receive({ type: 'entry', entry: { ...entry(4, 'whisper', 'คืนนี้เจอกันหลังวิหาร'), whisper: { from: 'ลิน', to: 'ดาริน', mine: true } } });
    socket.receive({ type: 'whisper_accepted' });
    socket.receive({ type: 'entry', entry: { ...entry(5, 'whisper', 'ได้ เจอกัน'), whisper: { from: 'ดาริน', to: 'ลิน', mine: false } } });
    expect((within(form).getByLabelText('ข้อความ Whisper') as HTMLTextAreaElement).value).toBe('');

    const list = screen.getByRole('region', { name: 'Whisper' });
    expect(within(list).getByText('ถึง ดาริน: คืนนี้เจอกันหลังวิหาร')).toBeTruthy();
    expect(within(list).getByText('จาก ดาริน: ได้ เจอกัน')).toBeTruthy();
    // Not mixed into the feed or the narration.
    expect(within(screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' })).queryByText(/เจอกัน/)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'สิ่งที่คุณรู้คนเดียว' })).queryByText(/เจอกัน/)).toBeNull();

    socket.receive({ type: 'whisper_rejected', code: 'not_allowed', message: 'ส่ง Whisper ถึงคนนี้ไม่ได้ ต้องเป็นพันธมิตรที่สนิทกันพอก่อน' });
    expect(within(form).getByRole('alert').textContent).toMatch(/พันธมิตร/);
  });

  it('GEN-067 C4: without an ally above +9 there is no Whisper form, only a note', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    expect(screen.queryByRole('form', { name: 'ส่ง Whisper' })).toBeNull();
    expect(screen.getByText('ยังไม่มีพันธมิตรที่สนิทพอจะ Whisper ได้')).toBeTruthy();
  });

  it('C7: a Single game uses the same room', async () => {
    const socket = await enterRoom(
      gameView({ mode: 'single', members: [{ id: me.id, name: 'นก', role: 'player', isOwner: true, hasCharacter: true }], players: { count: 1, min: 1, max: 1 } }),
    );
    socket.receive(roomState({ mode: 'single', members: [roomState().members[0]!] }));
    expect(screen.getByRole('heading', { name: /ห้องเล่น · วันที่ 1 · EOSORIA \(เช้า 06:00-11:59\) · เทิร์น 1\/2 · เล่นคนเดียว/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ส่ง action' })).toBeTruthy();
  });
});

describe('GEN-063 time system (web)', () => {
  it('C1: the heading shows the period and the turn', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ day: 5, phase: 'SOLARION', turn: 2 }));
    expect(screen.getByRole('heading', { name: /วันที่ 5 · SOLARION \(บ่าย 12:00-17:59\) · เทิร์น 2\/2/ })).toBeTruthy();
  });

  it('C3: in NOCTHERION the free Secret is explained, and once used tonight it is disabled', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ phase: 'NOCTHERION', turn: 2 }, { secretUsed: true }));
    expect(screen.getByText(/ส่ง Secret ได้ฟรี 1 เทิร์น/)).toBeTruthy();
    const secret = screen.getByLabelText(/^Secret/) as HTMLInputElement;
    expect(secret.disabled).toBe(true);
    expect(screen.getByText(/คืนนี้ใช้แล้ว/)).toBeTruthy();
  });

  it('C4: REST / SLEEP is sent with the action, and a Drowsy player is told the penalty', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ phase: 'NOCTHERION' }, { drowsy: true }));
    expect(screen.getByRole('note').textContent).toMatch(/ง่วงซึม.*d20 -2.*Stamina เพิ่ม 1/);
    fireEvent.change(screen.getByLabelText('action ของคุณ'), { target: { value: 'นอนที่โรงเตี๊ยม' } });
    fireEvent.click(screen.getByLabelText(/^REST \/ SLEEP/));
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'action', text: 'นอนที่โรงเตี๊ยม', visibility: 'public', rest: true });
    socket.receive({ type: 'action_accepted' });
    socket.receive(roomState({ phase: 'NOCTHERION' }, { action: { text: 'นอนที่โรงเตี๊ยม', visibility: 'public', rest: true } }));
    expect(screen.getByText(/ส่งแล้ว \(Public · REST \/ SLEEP\): นอนที่โรงเตี๊ยม/)).toBeTruthy();
  });
});
