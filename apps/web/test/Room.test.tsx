import { FALLBACK_NARRATION_LABEL, type GameView, type RoomEntry, type RoomServerMessage, type RoomState } from '@isekai/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
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
    weather: null,
    members: [
      { memberId: me.id, name: 'นก', role: 'player', online: true, submitted: false },
      { memberId: 'm-bee', name: 'บี', role: 'player', online: false },
    ],
    submittedCount: 0,
    you: { memberId: me.id, role: 'player', place: { id: 'market', name: 'ลานตลาด' }, lock: null, secretUsed: false, drowsy: false, action: null, allies: [], ...you },
    gmStatus: null,
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

/** What the Play screen loads besides the socket (GEN-088); a test overrides the one it is about. */
const PLAY_DATA: Record<string, () => Response> = {
  'GET /api/game/surroundings': () => Response.json({ view: 'player', you: null, place: null, people: [], npcs: [] }),
  'GET /api/game/companions': () => Response.json({ companions: [] }),
  'GET /api/game/inventory': () => Response.json({ inventory: { skills: [], items: [], discoveries: [] } }),
};

const topBar = () => screen.getByRole('group', { name: 'เวลาและสถานะเกม' });
const actionText = () => screen.getByLabelText(/^พิมพ์สิ่งที่จะทำ/) as HTMLInputElement;
const FEED = 'เหตุการณ์ที่นี่';
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

function loggedIn(game: GameView, more: Record<string, (init?: RequestInit) => Response> = {}) {
  localStorage.setItem(TOKEN_KEY, 'tok-abc');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? 'GET'} ${new URL(url, 'http://x').pathname}`;
      if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
      if (key === 'GET /api/me') return Response.json({ member: me });
      if (key === 'GET /api/game') return Response.json(game);
      const handler = more[key] ?? PLAY_DATA[key];
      if (!handler) throw new Error(`unexpected request ${key}`);
      return handler(init);
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
    // who is online sits behind [เมนู] in the top bar (Play screen v2)
    fireEvent.click(within(topBar()).getByRole('button', { name: 'เมนู' }));
    const list = screen.getByRole('list', { name: 'ผู้เล่นในห้อง' });
    expect(within(list).getByText('นก (คุณ) ออนไลน์')).toBeTruthy();
    expect(within(list).getByText('บี ออฟไลน์')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'ลานตลาด' })).toBeTruthy();
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

  it('C3 / Q-195: players see how many sent, never who; your own action is shown back to you', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ members: [roomState().members[0]!, { memberId: 'm-bee', name: 'บี', role: 'player', online: true }], submittedCount: 1 }));
    expect(within(topBar()).getByText('ส่งแล้ว 1/2')).toBeTruthy();
    fireEvent.click(within(topBar()).getByRole('button', { name: 'เมนู' }));
    const list = screen.getByRole('list', { name: 'ผู้เล่นในห้อง' });
    expect(within(list).getByText('บี ออนไลน์')).toBeTruthy();
    expect(within(list).getByText('นก (คุณ) ออนไลน์')).toBeTruthy();
    expect(list.textContent).not.toMatch(/ส่งแล้ว|ยังไม่ส่ง/);

    fireEvent.change(actionText(), { target: { value: 'แอบตามชายเสื้อคลุมดำ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'ลับ' }));
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'action', text: 'แอบตามชายเสื้อคลุมดำ', visibility: 'secret', rest: false });
    socket.receive({ type: 'action_accepted' });
    socket.receive(roomState({ submittedCount: 1 }, { action: { text: 'แอบตามชายเสื้อคลุมดำ', visibility: 'secret', rest: false } }));
    // GEN-122 C4: our own box (right) carries the word "ลับ", not only a colour
    const own = within(screen.getByRole('region', { name: FEED })).getByText('แอบตามชายเสื้อคลุมดำ').closest('.chat-row--own')!;
    expect(within(own as HTMLElement).getByText('ลับ')).toBeTruthy();
    // your own action comes back to you, with the count of who has sent and nothing else
    expect(screen.getByText('ส่งแล้ว (ลับ): แอบตามชายเสื้อคลุมดำ')).toBeTruthy();
    expect(screen.getByText('รอผู้เล่นอื่น ส่งแล้ว 1/2')).toBeTruthy();
    // it can be replaced until the turn closes
    fireEvent.click(screen.getByRole('button', { name: 'แก้ไข' }));
    expect(actionText().value).toBe('แอบตามชายเสื้อคลุมดำ');
    expect(screen.getByRole('button', { name: 'ส่งแทนของเดิม' })).toBeTruthy();
  });

  it('C4 / C8: public feed text and your private narration are one chat, narration italic with no box', async () => {
    const socket = await enterRoom();
    socket.receive({ type: 'entry', entry: entry(1, 'feed', 'ชายร่างสูงล้มแผงผลไม้') });
    socket.receive({ type: 'entry', entry: entry(2, 'narration', 'คุณเห็นรอยเท้าใต้โต๊ะ') });
    socket.receive(roomState());
    const feed = screen.getByRole('region', { name: FEED });
    expect(within(feed).getByText('— เช้า · เทิร์น 1 · ลานตลาด —')).toBeTruthy();
    for (const text of ['ชายร่างสูงล้มแผงผลไม้', 'คุณเห็นรอยเท้าใต้โต๊ะ']) {
      const line = within(feed).getByText(text);
      expect(line.className).toContain('chat-narration__text');
      expect(line.closest('.chat-box')).toBeNull();
    }
  });

  it('Q-177: a template narration carries the fallback label; the AI GM\'s own text does not', async () => {
    const socket = await enterRoom();
    socket.receive({ type: 'entry', entry: { ...entry(1, 'narration', 'คุณ: เช็ดโต๊ะ สำเร็จ'), fallback: true } });
    socket.receive({ type: 'entry', entry: entry(2, 'narration', 'แสงเทียนสั่นไหว') });
    socket.receive(roomState());
    const feed = screen.getByRole('region', { name: FEED });
    expect(within(within(feed).getByText('คุณ: เช็ดโต๊ะ สำเร็จ').closest('.chat-narration') as HTMLElement).getByText(FALLBACK_NARRATION_LABEL)).toBeTruthy();
    expect(within(within(feed).getByText('แสงเทียนสั่นไหว').closest('.chat-narration') as HTMLElement).queryByText(FALLBACK_NARRATION_LABEL)).toBeNull();
  });

  it('C5: an empty or too long action is stopped with a reason; a server refusal and a lock are shown', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    const sentBefore = socket.sent.length;
    fireEvent.change(actionText(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(screen.getByRole('alert').textContent).toBe('พิมพ์ action ก่อนส่ง');
    fireEvent.change(actionText(), { target: { value: 'ก'.repeat(1001) } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(screen.getByRole('alert').textContent).toMatch(/ไม่เกิน 1000/);
    expect(socket.sent.length).toBe(sentBefore);

    fireEvent.change(actionText(), { target: { value: 'เดินไปตลาด' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    socket.receive({ type: 'action_rejected', code: 'resolving', message: 'phase นี้ปิดรับ action แล้ว กำลังสรุปผล รอ phase ถัดไป' });
    expect(screen.getByRole('alert').textContent).toMatch(/ปิดรับ/);

    socket.receive(roomState({}, { lock: { code: 'exhausted', message: 'ตัวละครหมดแรง (Stamina 0) phase นี้ต้องนอนพัก ส่ง action ไม่ได้' } }));
    const note = screen.getByRole('note', { name: 'หมดแรง' });
    expect(note.textContent).toContain('ตัวละครหมดแรง (Stamina 0) phase นี้ต้องนอนพัก ส่ง action ไม่ได้');
    expect(note.textContent).toContain('ส่ง action ได้อีกครั้ง: EOSORIA เทิร์น 2');
    expect(actionText().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'ส่ง action' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('C6: after a drop it reconnects with the last seq it has and shows no entry twice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = await enterRoom();
    first.receive({ type: 'entry', entry: entry(3, 'feed', 'ฟีดหนึ่ง') });
    first.receive({ type: 'entry', entry: entry(5, 'narration', 'เล่าหนึ่ง') });
    first.receive(roomState());
    first.drop();
    expect(screen.getByRole('status', { name: 'การเชื่อมต่อห้อง' }).textContent).toMatch(/กำลังเชื่อมต่อใหม่/);

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
    const text = screen.getByRole('region', { name: FEED }).textContent ?? '';
    expect(text.indexOf('ฟีดหนึ่ง')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('ฟีดสอง')).toBeGreaterThan(text.indexOf('ฟีดหนึ่ง'));
    expect(screen.getByRole('status', { name: 'การเชื่อมต่อห้อง' }).textContent).toBe('เชื่อมต่อแล้ว');
  });

  it('GEN-067 C4 / C6: Whisper goes to the chosen ally by ref; sent and received Whispers are listed apart', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({}, { allies: [{ ref: 'ref-darin', name: 'ดาริน' }] }));

    // Whisper lives in the "คนรอบตัว" tab of the info panel
    tab('คนรอบตัว');
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
    expect(within(screen.getByRole('region', { name: FEED })).queryByText(/เจอกัน/)).toBeNull();
    expect(list.closest('.info-panel')).toBeTruthy();

    socket.receive({ type: 'whisper_rejected', code: 'not_allowed', message: 'ส่ง Whisper ถึงคนนี้ไม่ได้ ต้องเป็นพันธมิตรที่สนิทกันพอก่อน' });
    expect(within(form).getByRole('alert').textContent).toMatch(/พันธมิตร/);
  });

  it('GEN-067 C4: without an ally above +9 there is no Whisper form, only a note', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    tab('คนรอบตัว');
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

describe('GEN-115 GM is narrating (web)', () => {
  it('C2: while the turn resolves the room shows "GM กำลังเล่า..." with the elapsed seconds, and clears when it is over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await enterRoom();
    expect(screen.queryByRole('status', { name: 'GM กำลังเล่า' })).toBeNull();
    socket.receive(roomState({ status: 'resolving' }));
    const status = screen.getByRole('status', { name: 'GM กำลังเล่า' });
    expect(status.textContent).toBe('GM กำลังเล่า... 0 วินาที');
    act(() => void vi.advanceTimersByTime(7_000));
    expect(status.textContent).toBe('GM กำลังเล่า... 7 วินาที');
    socket.receive(roomState({ status: 'collecting', turn: 2 }));
    expect(screen.queryByRole('status', { name: 'GM กำลังเล่า' })).toBeNull();
  });

  it('C5: a stuck AI GM shows its message and retry instead of the narrating status', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ status: 'resolving', gmStatus: { code: 'stuck', message: 'AI GM ติดขัด', canRetry: true } }));
    expect(screen.queryByRole('status', { name: 'GM กำลังเล่า' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeTruthy();
  });
});

describe('GEN-057 AI GM status (web)', () => {
  it('C2: a stuck AI GM is shown with a retry button that sends retry', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ status: 'resolving', gmStatus: { code: 'stuck', message: 'AI GM ติดขัด สรุปผลเทิร์นนี้ไม่ได้', canRetry: true } }));
    expect(screen.getByRole('alert').textContent).toContain('AI GM ติดขัด');
    fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'retry' });
  });

  it('C7: the ceiling message is shown without a retry button', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ status: 'resolving', gmStatus: { code: 'budget_reached', message: 'ใช้ครบเพดานของเดือนนี้แล้ว', canRetry: false } }));
    expect(screen.getByRole('alert').textContent).toContain('เพดาน');
    expect(screen.queryByRole('button', { name: 'ลองใหม่' })).toBeNull();
  });
});

describe('GEN-055 skills and items (web)', () => {
  const skill = { id: 's-1', name: 'Ward of Light', rank: 'B', alignment: 'Good', category: 'Defensive', triggerType: 'Passive', dailyLimit: 0, description: 'สร้างม่านแสงบาง ๆ' };
  const rosary = { id: 'i-1', name: 'Silver Rosary of Hearth', rank: 'B', alignment: 'Good', category: 'Accessory', triggerType: 'Passive', dailyLimit: 0, description: 'ฟื้นฟู HP +4' };

  it('Q-106 / C7: the panel shows your own skills, the items you hold now and what you found at the library', async () => {
    const inventories = [
      { inventory: { skills: [skill], items: [rosary], discoveries: [{ kind: 'skill', name: 'The First Light', text: 'สวดภาวนาอธิษฐาน 3 วัน' }] } },
      // After a steal the list is what the server says you hold now.
      { inventory: { skills: [skill], items: [], discoveries: [] } },
    ];
    let call = 0;
    loggedIn(gameView(), { 'GET /api/game/inventory': () => Response.json(inventories[Math.min(call++, 1)]) });
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    const socket = await waitFor(() => FakeSocket.all.at(-1)!);
    socket.open();
    socket.receive(roomState());

    // skills under ตัวฉัน, items + clues under กระเป๋า; both load by themselves
    tab('ตัวฉัน');
    const skills = await screen.findByRole('region', { name: 'ความสามารถและของ' });
    expect((await within(skills).findByText('Ward of Light')).closest('li')!.textContent).toContain('Rank B · Passive');
    tab('กระเป๋า');
    const panel = await screen.findByRole('region', { name: 'ความสามารถและของ' });
    expect((await within(panel).findByText('Silver Rosary of Hearth')).closest('li')!.textContent).toContain('Rank B');
    expect(within(panel).getByText('The First Light: สวดภาวนาอธิษฐาน 3 วัน')).toBeTruthy();

    // it loads again when the turn moves on: after a steal the list is what the server says you hold now
    socket.receive(roomState({ turn: 2 }));
    await waitFor(() => expect(within(panel).queryByText('Silver Rosary of Hearth')).toBeNull());
    expect(within(panel).queryByText(/เบาะแสที่ค้นพบ/)).toBeNull();
  });
});

describe('GEN-058 Human GM console in the play room (web)', () => {
  it('the GM gets the console, which reloads when the room says a turn waits for approval; players get none', async () => {
    const gmGame = gameView({
      humanGm: true,
      you: { memberId: me.id, role: 'gm', isOwner: true },
      members: [
        { id: me.id, name: 'นก', role: 'gm', isOwner: true, hasCharacter: false },
        { id: 'm-bee', name: 'บี', role: 'player', isOwner: false, hasCharacter: true },
      ],
    });
    let consoleCalls = 0;
    const view = (pending: boolean) => ({
      view: 'gm',
      at: { day: 1, phase: 'EOSORIA', turn: 1 },
      status: pending ? 'resolving' : 'collecting',
      characters: [],
      evidence: [],
      actions: [],
      events: [],
      legendaries: [],
      pending: pending ? { at: { day: 1, phase: 'EOSORIA', turn: 1 }, entries: [{ index: 0, kind: 'narration', memberId: 'm-bee', locationId: null, text: 'ฉบับเดิม', edited: false }], results: [] } : null,
      fallbacks: [],
    });
    loggedIn(gmGame, {
      'GET /api/game/gm/console': () => Response.json(view(++consoleCalls > 1)),
      'GET /api/game/gm/log': () => Response.json({ overrides: [] }),
    });
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    const socket = await waitFor(() => FakeSocket.all.at(-1) ?? Promise.reject(new Error('no socket yet')));
    socket.open();
    socket.receive(roomState({}, { role: 'gm', place: null, lock: { code: 'not_a_player', message: 'GM ไม่มีตัวละคร จึงส่ง action ไม่ได้' } }));
    expect(await screen.findByText('ยังไม่มีผลของเทิร์นที่รออนุมัติ')).toBeTruthy();
    socket.receive(
      roomState(
        { status: 'resolving', gmStatus: { code: 'awaiting_gm', message: 'ผลของเทิร์นนี้รอคุณตรวจใน GM console', canRetry: false } },
        { role: 'gm', place: null, lock: null },
      ),
    );
    const turn = await screen.findByRole('region', { name: 'ผลของเทิร์นที่รออนุมัติ' });
    expect((within(turn).getByLabelText(/ข้อความ 1/) as HTMLTextAreaElement).value).toBe('ฉบับเดิม');
  });

  it('a player never loads the console', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ status: 'resolving', gmStatus: { code: 'awaiting_gm', message: 'ผลของเทิร์นนี้รอ GM ตรวจ', canRetry: false } }));
    expect(screen.getByText('ผลของเทิร์นนี้รอ GM ตรวจ')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'GM console' })).toBeNull();
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
    expect(screen.getByText(/คืนนี้ลับฟรี 1 เทิร์น/)).toBeTruthy();
    const secret = screen.getByRole('checkbox', { name: 'ลับ' }) as HTMLInputElement;
    expect(secret.disabled).toBe(true);
    expect(screen.getByText('ใช้ลับฟรีของคืนนี้แล้ว รีเซ็ตเช้าวันที่ 2')).toBeTruthy();
  });

  it('C4: REST / SLEEP is sent with the action, and a Drowsy player is told the penalty', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({ phase: 'NOCTHERION' }, { drowsy: true }));
    // the penalty in words: players never get the d20 change as a number (GEN-088 C3)
    expect(screen.getByRole('note').textContent).toBe('ง่วงซึมทั้งวัน: ทอยยากขึ้น เหนื่อยขึ้นทุก action');
    fireEvent.change(actionText(), { target: { value: 'นอนที่โรงเตี๊ยม' } });
    fireEvent.click(screen.getByRole('button', { name: 'พัก' }));
    expect(actionText().value).toBe('พัก นอนที่โรงเตี๊ยม');
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    // GEN-137 (Q-301 B): the button only fills the word; the server reads REST from the text (GEN-113).
    expect(socket.sent.at(-1)).toEqual({ type: 'action', text: 'พัก นอนที่โรงเตี๊ยม', visibility: 'public', rest: false });
    socket.receive({ type: 'action_accepted' });
    socket.receive(roomState({ phase: 'NOCTHERION' }, { action: { text: 'พัก นอนที่โรงเตี๊ยม', visibility: 'public', rest: true } }));
    expect(screen.getByText('ส่งแล้ว (เปิดเผย · พัก / นอน): พัก นอนที่โรงเตี๊ยม')).toBeTruthy();
  });

  it('[พัก] like every quick word only fills the box and sends nothing by itself; sent, it carries no rest flag (GEN-122 C3, GEN-137 C3)', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    const before = socket.sent.length;
    fireEvent.click(screen.getByRole('button', { name: 'สังเกต' }));
    expect(actionText().value).toBe('สังเกต');
    expect(socket.sent.length).toBe(before);
    fireEvent.change(actionText(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'พัก' }));
    expect(actionText().value).toBe('พัก');
    expect(socket.sent.length).toBe(before);
    expect(screen.getByRole('button', { name: 'พัก' }).getAttribute('aria-pressed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'action', text: 'พัก', visibility: 'public', rest: false });
  });
});

describe('GEN-069 TRAIN at the guild (web)', () => {
  it('TRAIN is sent with the action (not with REST), the refusal is shown, and the sent action says TRAIN', async () => {
    const socket = await enterRoom();
    socket.receive(roomState({}));
    fireEvent.click(screen.getByRole('button', { name: 'พัก' }));
    fireEvent.change(actionText(), { target: { value: 'ฝึกซ้อมที่ลานกิลด์' } });
    fireEvent.click(screen.getByRole('button', { name: 'ฝึก TRAIN' }));
    expect(screen.getByRole('button', { name: 'พัก' }).getAttribute('aria-pressed')).toBeNull();
    expect(screen.getByRole('button', { name: 'ฝึก TRAIN' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'action', text: 'ฝึกซ้อมที่ลานกิลด์', visibility: 'public', rest: false, train: true });
    socket.receive({ type: 'action_rejected', code: 'train_used', message: 'วันนี้ฝึกที่กิลด์ไปแล้ว ฝึกได้วันละ 1 ครั้ง' });
    expect(await screen.findByText('วันนี้ฝึกที่กิลด์ไปแล้ว ฝึกได้วันละ 1 ครั้ง')).toBeTruthy();
    socket.receive(roomState({}, { action: { text: 'ฝึกซ้อมที่ลานกิลด์', visibility: 'public', rest: false, train: true } }));
    expect(screen.getByText('ส่งแล้ว (เปิดเผย · TRAIN): ฝึกซ้อมที่ลานกิลด์')).toBeTruthy();
  });
});

describe('GEN-068 weather (web)', () => {
  it('C1: the top bar shows the period weather in Thai, with Disaster from day 5; "รอ GM" before it is picked', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    expect(within(topBar()).getByText('อากาศ: รอ GM')).toBeTruthy();
    socket.receive(roomState({ weather: { weather: 'Rain', disaster: false } }));
    expect(within(topBar()).getByText('ฝนตก')).toBeTruthy();
    expect(within(topBar()).queryByText('อากาศ: รอ GM')).toBeNull();
    socket.receive(roomState({ day: 5, weather: { weather: 'Clear', disaster: true } }));
    expect(within(topBar()).getByText('แดดจ้า · ภัยพิบัติ')).toBeTruthy();
  });
});

describe('GEN-101 Play as its own page (Q-265)', () => {
  it('while playing, the app header is not on the page (nor tabbable); the menu leads back to the lobby, where it returns', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    expect(screen.queryByRole('button', { name: 'ออกจากเกม' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'รายการเกม' })).toBeNull();
    fireEvent.click(within(topBar()).getByRole('button', { name: 'เมนู' }));
    fireEvent.click(screen.getByRole('button', { name: 'กลับห้องรอ' }));
    expect(await screen.findByRole('button', { name: 'ออกจากเกม' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'รายการเกม' })).toBeTruthy();
  });

  it('the menu also opens the game list from Play', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    fireEvent.click(within(topBar()).getByRole('button', { name: 'เมนู' }));
    fireEvent.click(screen.getByRole('button', { name: 'รายการเกม' }));
    expect(await screen.findByRole('button', { name: 'ออกจากเกม' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'รายการเกม', pressed: true })).toBeTruthy();
  });
});

describe('GEN-101 [รับทราบ] persists (Q-267)', () => {
  const hit: RoomEntry = { ...entry(7, 'hit', 'มีคนผลักคุณล้ม'), place: null, hit: { actor: null, changes: [] } };
  const pinned = () => screen.queryByRole('button', { name: 'รับทราบ' });

  it('an acknowledged hit stays acknowledged after a reload; storage keyed by game + member + seq', async () => {
    let socket = await enterRoom();
    socket.receive(roomState());
    socket.receive({ type: 'entry', entry: hit });
    fireEvent.click(await screen.findByRole('button', { name: 'รับทราบ' }));
    expect(pinned()).toBeNull();
    expect(localStorage.getItem('isekai.hitAck.g-1.m-lin.7')).toBe('1');
    cleanup();
    FakeSocket.all = [];

    socket = await enterRoom();
    socket.receive(roomState());
    socket.receive({ type: 'entry', entry: hit });
    expect(await screen.findByText(/มีคนผลักคุณล้ม/)).toBeTruthy();
    expect(pinned()).toBeNull();
  });

  it('without localStorage the page still works (the card just pins again)', async () => {
    const real = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith('isekai.hitAck')) throw new Error('blocked');
      return real.call(this, key);
    });
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('isekai.hitAck')) throw new Error('blocked');
      realSet.call(this, key, value);
    });
    try {
      const socket = await enterRoom();
      socket.receive(roomState());
      socket.receive({ type: 'entry', entry: hit });
      fireEvent.click(await screen.findByRole('button', { name: 'รับทราบ' }));
      expect(pinned()).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('GEN-101 history, companions, arrival line (Q-268)', () => {
  async function openRoom() {
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    const socket = await waitFor(() => FakeSocket.all.at(-1)!);
    socket.open();
    socket.receive(roomState());
    return socket;
  }

  it('a: [ประวัติ] opens the game log of this game from GET /api/game/log and goes back to Play', async () => {
    const asked: string[] = [];
    loggedIn(gameView(), {
      'GET /api/game/log': () => {
        asked.push('log');
        return Response.json(CONTRACT_FIXTURES.GameLogResponse[1]);
      },
      'GET /api/game/rating': () => Response.json(CONTRACT_FIXTURES.GameRatingResponse[1]),
    });
    render(<App apiBaseUrl="" />);
    await openRoom();
    fireEvent.click(within(topBar()).getByRole('button', { name: 'ประวัติ' }));
    const back = await screen.findByRole('button', { name: /กลับ/ });
    expect(asked).toEqual(['log']);
    fireEvent.click(back);
    expect(await screen.findByRole('region', { name: FEED })).toBeTruthy();
  });

  const around = (npcs: { ref: string; name: string; nameRevealed: boolean }[]) => () => Response.json({ ...CONTRACT_FIXTURES.SurroundingsResponse[0], npcs });
  const mine = [{ ref: 'n-1', name: 'เด็กชายตัวผอม', nameRevealed: false, role: 'main' as const }];
  const doc = { ref: 'n-9', name: 'หมอยาจร', nameRevealed: false, role: 'secondary' as const };

  it('b: an NPC here that is not yet a companion has [บันทึกเป็นคู่หู]; it posts the ref and the list reloads', async () => {
    const calls: string[] = [];
    let saved = false;
    loggedIn(gameView(), {
      'GET /api/game/surroundings': around([
        { ref: 'n-9', name: 'หมอยาจร', nameRevealed: true },
        { ref: 'n-8', name: 'หญิงสาวผู้พกนาฬิกา', nameRevealed: false },
      ]),
      'GET /api/game/companions': () => Response.json({ companions: saved ? [...mine, doc] : mine }),
      'POST /api/game/companions': (init) => {
        calls.push(String(init?.body));
        saved = true;
        return Response.json({ companions: [...mine, doc] }, { status: 201 });
      },
    });
    render(<App apiBaseUrl="" />);
    await openRoom();
    tab('คนรอบตัว');
    const saveButton = await screen.findByRole('button', { name: 'บันทึกหมอยาจรเป็นคู่หู' });
    // GEN-121: an NPC the player does not know yet has no [บันทึก].
    expect(screen.queryByRole('button', { name: 'บันทึกหญิงสาวผู้พกนาฬิกาเป็นคู่หู' })).toBeNull();
    fireEvent.click(saveButton);
    await waitFor(() => expect(calls).toEqual([JSON.stringify({ ref: 'n-9' })]));
    expect(await screen.findByRole('button', { name: 'ปล่อยหมอยาจร' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'บันทึกหมอยาจรเป็นคู่หู' })).toBeNull();
  });

  it('b: [ปล่อย] on a companion sends DELETE with the ref; the server refusal is shown, not thrown', async () => {
    const calls: string[] = [];
    loggedIn(gameView(), {
      'GET /api/game/surroundings': around([]),
      'GET /api/game/companions': () => Response.json({ companions: mine }),
      'DELETE /api/game/companions/n-1': () => {
        calls.push('n-1');
        return Response.json({ code: 'not_allowed', message: 'ปล่อยไม่ได้ตอนนี้' }, { status: 409 });
      },
    });
    render(<App apiBaseUrl="" />);
    await openRoom();
    tab('คนรอบตัว');
    fireEvent.click(await screen.findByRole('button', { name: 'ปล่อยเด็กชายตัวผอม' }));
    expect(await screen.findByText('ปล่อยไม่ได้ตอนนี้')).toBeTruthy();
    expect(calls).toEqual(['n-1']);
  });

  it('c: a thin "คุณมาถึง..." line sits after the last thing at the old place, and not before any move', async () => {
    const socket = await enterRoom();
    socket.receive(roomState());
    const at = (seq: number, id: string, name: string, text: string): RoomEntry => ({ ...entry(seq, 'feed', text), place: { id, name } });
    socket.receive({ type: 'entry', entry: at(1, 'market', 'ลานตลาด', 'เสียงตลาด') });
    expect(screen.queryByText(/คุณมาถึง/)).toBeNull();
    socket.receive(roomState({}, { place: { id: 'church', name: 'โบสถ์' } }));
    socket.receive({ type: 'entry', entry: at(2, 'church', 'โบสถ์', 'เสียงระฆัง') });
    const line = await screen.findByText('— คุณมาถึงโบสถ์ —');
    const items = [...line.closest('ol')!.querySelectorAll('li')].map((li) => li.textContent ?? '');
    const arrived = items.findIndex((s) => s.includes('คุณมาถึงโบสถ์'));
    expect(arrived).toBe(items.findIndex((s) => s.includes('เสียงตลาด')) + 1);
    expect(items.findIndex((s) => s.includes('เสียงระฆัง'))).toBeGreaterThan(arrived);
  });
});
