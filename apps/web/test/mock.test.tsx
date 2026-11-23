// GEN-100: the mock layer over the GEN-099 fixtures. C2 every scenario shows its state on the real pages,
// C4 every payload the mock can send passes the contract schema, C6 without the mock nothing changes.
import { ApiError, RoomServerMessage } from '@isekai/protocol';
import { CONTRACT, CONTRACT_FIXTURES, CONTRACT_SCHEMAS, type HttpItem } from '@isekai/protocol/contract';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmConsoleFrame } from '../src/dev/previews.tsx';
import { GameSummaryPage } from '../src/GameHistory.tsx';
import { LearningLibrary } from '../src/LearningLibrary.tsx';
import { mockHttp } from '../src/mock/http.ts';
import { installMock, MOCK_TOKEN, mockBaseUrl, mockRoom } from '../src/mock/install.ts';
import { MockRoomServer, type MockPeer } from '../src/mock/room.ts';
import { SCENARIOS, scenarioById, type MockScenario } from '../src/mock/scenarios.ts';
import { PlayRoom } from '../src/PlayRoom.tsx';

const REQUIRED = [
  'normal',
  'waiting',
  'exhausted',
  'unconscious',
  'astral',
  'secret-used',
  'hit',
  'reconnect',
  'period-change',
  'ended',
  'library-empty',
  'library-loading',
  'library-error',
] as const;

const noop = () => {};
let uninstall: () => void;
let cell = 0;

beforeEach(() => {
  localStorage.clear();
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
});

function playRoom(scenario: string) {
  const baseUrl = mockBaseUrl(scenario, `t${++cell}`);
  render(<PlayRoom apiBaseUrl={baseUrl} token={MOCK_TOKEN} onBack={noop} onGameList={noop} onNeedCharacter={noop} onSessionLost={noop} />);
  return baseUrl;
}
const form = () => screen.getByRole('form', { name: 'ส่ง action' });
/** Scripts at half speed: at 0.01 a first step (15-20 ms) can pass before the first check when the suite runs under load. */
function slowScripts() {
  uninstall();
  uninstall = installMock({ timeScale: 0.5, latencyMs: 0 });
}

describe('C2 every scenario shows its state', () => {
  it('has every scenario of the task, each with a Thai title and the screens it applies to', () => {
    const ids = SCENARIOS.map((s) => s.id);
    for (const id of REQUIRED) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENARIOS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.screens.length).toBeGreaterThan(0);
      // a scenario id is a host label of the mock base URL
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
    }
    expect(scenarioById('no-such').id).toBe('normal');
  });

  it('normal: the room opens online, at the fountain, collecting actions', async () => {
    playRoom('normal');
    expect(await screen.findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'น้ำพุกลางเมือง' })).toBeTruthy();
    // collecting actions: the box is open
    expect((within(form()).getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
    expect((within(form()).getByRole('button', { name: 'ส่ง action' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('GEN-131 C1 normal: after sending an action the submitted counter never exceeds the players', () => {
    const server = new MockRoomServer(scenarioById('normal'), { timeScale: 0.01 });
    const sent: unknown[] = [];
    const peer: MockPeer = { deliver: (m) => sent.push(m), drop: noop };
    server.hello(peer, { type: 'hello', token: MOCK_TOKEN, afterSeq: 0 });
    server.receive(peer, { type: 'action', text: 'เดินสำรวจน้ำพุ', visibility: 'public', rest: false, train: false });
    server.stop();
    const rooms = sent.filter((m): m is { type: 'room'; members: { role: string }[]; submittedCount: number } => (m as { type?: string }).type === 'room');
    const last = rooms[rooms.length - 1]!;
    expect(last.submittedCount).toBe(1);
    expect(last.submittedCount).toBeLessThanOrEqual(last.members.filter((m) => m.role === 'player').length);
  });

  it('GEN-140 C1/C2 a Thai place name shows as Thai (no &#NNNN;) and markup in it stays text', async () => {
    const normal = scenarioById('normal');
    const names = ['หอคอยทิศเหนือ', 'ร้าน <b>x</b> & "y"'];
    for (const [i, name] of names.entries()) {
      const id = `place-text-${i}`;
      (SCENARIOS as MockScenario[]).push({ ...normal, id, room: { ...normal.room, state: { ...normal.room.state, you: { ...normal.room.state.you, place: { id: 'p-x', zone: normal.room.state.you.place?.zone ?? null, name } } } } } as MockScenario);
      playRoom(id);
      expect(await screen.findByText(`— คุณมาถึง${name} —`)).toBeTruthy();
      expect(screen.getByRole('heading', { name })).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/&#\d+;/);
      expect(document.querySelector('b')).toBeNull();
      cleanup();
      (SCENARIOS as MockScenario[]).pop();
    }
  });

  it('waiting: your action is in and the others are still sending, then the turn closes', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('waiting');
    expect(await screen.findByText(/^ส่งแล้ว \(เปิดเผย\)/)).toBeTruthy();
    expect(screen.getByText('รอผู้เล่นอื่น ส่งแล้ว 2/3')).toBeTruthy();
    // the script plays in order: the last player sends, then the turn closes
    expect(await screen.findByText('รอผู้เล่นอื่น ส่งแล้ว 3/3', {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText('กำลังสรุปผล SOLARION เทิร์น 1…', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('astral: the action box is gone; the lock message and the omen box are there', async () => {
    playRoom('astral');
    expect(await screen.findByText('ลินเป็น Astral Spirit ตั้งแต่วันที่ 6 HESPERION')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'ส่ง action' })).toBeNull();
    expect(screen.getByRole('form', { name: 'ส่งลางสังหรณ์' })).toBeTruthy();
  });

  it.each([
    ['exhausted', 'คุณหมดแรง ต้องพักเทิร์นนี้'],
    ['unconscious', 'คุณสลบ 1 เทิร์น'],
    ['resolving', 'กำลังสรุปผล SOLARION เทิร์น 1…'],
    ['traveling', 'กำลังเดินทางไป ป่า ถึงเมื่อจบเทิร์นนี้'],
    ['recovering', 'พักฟื้นที่สถานพยาบาลกลาง เหลือ 1 เทิร์น'],
  ])('%s: the action box is locked with the lock message', async (scenario, message) => {
    playRoom(scenario);
    expect(await screen.findByText(message)).toBeTruthy();
    expect((within(form()).getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('secret-used: Secret cannot be picked today', async () => {
    playRoom('secret-used');
    const secret = (await screen.findByRole('checkbox', { name: 'ลับ' })) as HTMLInputElement;
    expect(secret.disabled).toBe(true);
    expect(screen.getByText(/^ใช้ลับวันนี้แล้ว/)).toBeTruthy();
  });

  it('stuck: the AI GM is stuck and the retry button clears it', async () => {
    playRoom('stuck');
    const retry = await screen.findByRole('button', { name: 'ลองใหม่' });
    expect(screen.getByText('AI GM ติดขัด')).toBeTruthy();
    retry.click();
    await waitFor(() => expect(screen.queryByText('AI GM ติดขัด')).toBeNull());
  });

  it('single: the room is in Single mode', async () => {
    playRoom('single');
    expect(await screen.findByText(/เล่นคนเดียว/)).toBeTruthy();
  });

  it('hit: the hit from someone else arrives after the room opens', async () => {
    playRoom('hit');
    expect(await screen.findByText('ถุงเงินของคุณหายไป')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'เกิดกับคุณ' })).toBeTruthy();
  });

  it('reconnect: the socket drops, comes back and fills in what it missed', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('reconnect');
    expect(await screen.findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    expect(await screen.findByText(/หลุดการเชื่อมต่อ/, {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText('เชื่อมต่อแล้ว', {}, { timeout: 4000 })).toBeTruthy();
    expect(await screen.findByText(/ระหว่างที่คุณหลุด/)).toBeTruthy();
  });

  it('period-change: the turn moves on to the next period with new weather', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('period-change');
    expect(await screen.findByRole('heading', { name: /SOLARION.*เทิร์น 1\/2/ })).toBeTruthy();
    const weather = () => document.querySelector('.hud-time__weather')!.textContent;
    const rain = weather();
    expect(rain).toContain('ฝนตก');
    expect(await screen.findByRole('heading', { name: /HESPERION.*เทิร์น 1\/2/ }, { timeout: 3000 })).toBeTruthy();
    expect(weather()).not.toBe(rain);
  });

  // GEN-091 (Q-253): the end page and the library are the real screens now, not the GEN-100 stand-ins.
  it('ended: the end page shows the end and everyone\'s secrets, and the rating form sends on the mock', async () => {
    render(<GameSummaryPage apiBaseUrl={mockBaseUrl('ended', `t${++cell}`)} token={MOCK_TOKEN} onBack={noop} />);
    expect(await screen.findByRole('region', { name: 'ความลับของทุกคน' })).toBeTruthy();
    expect(screen.getByText(/เส้นทาง Good/)).toBeTruthy();
    const rating = within(screen.getByRole('region', { name: 'ให้คะแนนเกม' }));
    expect(await rating.findByText('ยังไม่มีคะแนน')).toBeTruthy();
    (await rating.findByRole('radio', { name: '9' })).click();
    rating.getByRole('button', { name: 'ส่งคะแนน' }).click();
    expect(await rating.findByText('ส่งแล้ว · แก้ได้')).toBeTruthy();
    expect(rating.getByText('คะแนนเกม 8.60 จาก 3 คน')).toBeTruthy();
  });

  it.each([
    ['ended-rated', 'คะแนนเกม 8.60 จาก 3 คน'],
    ['ended-low', 'คะแนนเกม 7.40 จาก 3 คน'],
  ])('%s: opens as sent with its game score (GEN-079: no pass / fail gate)', async (scenario, status) => {
    render(<GameSummaryPage apiBaseUrl={mockBaseUrl(scenario, `t${++cell}`)} token={MOCK_TOKEN} onBack={noop} />);
    const rating = within(await screen.findByRole('region', { name: 'ให้คะแนนเกม' }));
    expect(await rating.findByText('ส่งแล้ว · แก้ได้')).toBeTruthy();
    expect(rating.getByText(status)).toBeTruthy();
  });

  it('library-empty / library-loading / library-error', async () => {
    const library = (scenario: string) => render(<LearningLibrary apiBaseUrl={mockBaseUrl(scenario, `t${++cell}`)} token="mock-admin" onForbidden={noop} />);
    library('library-empty');
    expect(await screen.findByText('ยังไม่มีความรู้ใน library')).toBeTruthy();
    cleanup();
    library('library-loading');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('status', { name: 'กำลังโหลด…' })).toBeTruthy();
    cleanup();
    library('library-error');
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    library('normal');
    expect(await screen.findByText('ผู้เล่นยื่นเหรียญให้ทหารยาม → ปานกลาง สำเร็จ')).toBeTruthy();
  });

  it('gm / gm-finale / gm-budget: the console shows the held turn, the held finale, the budget status', async () => {
    const consoleOf = (scenario: string) => render(<GmConsoleFrame apiBaseUrl={mockBaseUrl(scenario, `t${++cell}`)} token={MOCK_TOKEN} />);
    consoleOf('gm');
    expect(await screen.findByRole('region', { name: 'ผลของเทิร์นที่รออนุมัติ' })).toBeTruthy();
    expect((await screen.findByRole('status', { name: 'สถานะ AI GM' })).textContent).toContain('รอคุณอนุมัติ');
    cleanup();
    consoleOf('gm-finale');
    expect(await screen.findByRole('region', { name: 'ตอนจบที่รออนุมัติ' })).toBeTruthy();
    cleanup();
    consoleOf('gm-budget');
    expect((await screen.findByRole('status', { name: 'สถานะ AI GM' })).textContent).toContain('ถึงเพดานงบ AI');
  });
});

/** Fills a path pattern's `:params` so the route matches. */
const concrete = (item: HttpItem) => item.path.replace(/:(\w+)/g, (_, name: string) => `x-${name}`);

function sampleRequest(item: HttpItem): unknown {
  return item.request ? CONTRACT_FIXTURES[item.request][0] : undefined;
}

/** Every message the mock room server sends, through every operation it knows. */
function everyRoomMessage(scenarioId: string): unknown[] {
  const sent: unknown[] = [];
  const server = new MockRoomServer(scenarioById(scenarioId), { timeScale: 0 });
  const peer: MockPeer = { deliver: (m) => sent.push(m), drop: noop };
  server.hello(peer, { type: 'hello', token: MOCK_TOKEN, afterSeq: 0 });
  for (const m of [
    ...CONTRACT_FIXTURES.RoomAction,
    ...CONTRACT_FIXTURES.RoomWhisper,
    ...CONTRACT_FIXTURES.RoomRetry,
    ...CONTRACT_FIXTURES.RoomMove,
    ...CONTRACT_FIXTURES.RoomOmen,
    { type: 'action', text: 'ลอบเข้าโบสถ์', visibility: 'secret' },
  ]) {
    server.receive(peer, m);
  }
  server.othersSubmit();
  server.hit();
  for (let i = 0; i < 9; i++) server.nextTurn();
  server.drop();
  server.hello(peer, { type: 'hello', token: MOCK_TOKEN, afterSeq: 3 });
  for (const step of server.scenario.room.script) server.run(step.op);
  server.stop();
  return sent;
}

describe('C4 every mock payload passes the GEN-099 schema', () => {
  it.each(SCENARIOS.map((s) => [s.id]))('%s: every HTTP answer of the contract', async (id) => {
    const scenario = scenarioById(id);
    const failures: string[] = [];
    for (const item of CONTRACT.filter((c): c is HttpItem => c.kind === 'http')) {
      const reply = mockHttp(scenario, { method: item.method, path: concrete(item), body: sampleRequest(item) });
      if (!('status' in reply)) continue; // network failure / still loading: no payload
      const where = `${item.method} ${item.path}`;
      if (reply.status === 204) {
        if (item.response !== null) failures.push(`${where}: 204 but the contract has a body`);
        continue;
      }
      const schema = reply.status < 300 ? (item.response ? CONTRACT_SCHEMAS[item.response] : null) : ApiError;
      if (!schema) {
        failures.push(`${where}: ${reply.status} with a body, the contract says 204`);
        continue;
      }
      const parsed = schema.safeParse(reply.body);
      if (!parsed.success) failures.push(`${where}: ${parsed.error.message}`);
    }
    expect(failures).toEqual([]);
  });

  it.each(SCENARIOS.map((s) => [s.id]))('%s: every room message', (id) => {
    const messages = everyRoomMessage(id);
    expect(messages.length).toBeGreaterThan(3);
    const failures = messages.flatMap((m) => {
      const parsed = RoomServerMessage.safeParse(m);
      return parsed.success ? [] : [`${JSON.stringify(m).slice(0, 120)}: ${parsed.error.message}`];
    });
    expect(failures).toEqual([]);
  });

  it('a request that fails the contract schema gets a 400 invalid_input', () => {
    const reply = mockHttp(scenarioById('normal'), { method: 'POST', path: '/api/join', body: { inviteCode: '', name: '', pin: 'x' } });
    expect('status' in reply && reply.status).toBe(400);
    expect('status' in reply && ApiError.parse(reply.body).code).toBe('invalid_input');
  });

  it('the room replays only the entries after afterSeq, then ready', () => {
    const sent: { type: string; entry?: { seq: number } }[] = [];
    const server = new MockRoomServer(scenarioById('normal'), { timeScale: 0 });
    server.hello({ deliver: (m) => sent.push(m as never), drop: noop }, { type: 'hello', token: MOCK_TOKEN, afterSeq: 12 });
    expect(sent[0]!.type).toBe('room');
    expect(sent.filter((m) => m.type === 'entry').every((m) => m.entry!.seq > 12)).toBe(true);
    expect(sent.at(-1)!.type).toBe('ready');
  });
});

describe('the mock transport', () => {
  it('answers fetch to a mock base URL and passes other URLs to the real fetch', async () => {
    uninstall();
    const real = vi.fn(async () => new Response('real'));
    vi.stubGlobal('fetch', real);
    uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    const res = await fetch(`${mockBaseUrl('normal')}/health`);
    expect(await res.json()).toEqual({ ok: true, db: 'connected' });
    expect(real).not.toHaveBeenCalled();
    await fetch('http://localhost:5173/src/main.tsx');
    expect(real).toHaveBeenCalledTimes(1);
    uninstall();
    expect(globalThis.fetch).toBe(real);
    vi.unstubAllGlobals();
    uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
  });

  it('mockRoom gives the same server the page talks to', async () => {
    const baseUrl = playRoom('normal');
    await screen.findByText('เชื่อมต่อแล้ว');
    mockRoom(baseUrl).nextTurn();
    expect(await screen.findByRole('heading', { name: /SOLARION.*เทิร์น 2\/2/ })).toBeTruthy();
  });
});

describe('C6 without VITE_MOCK the web is unchanged', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  it('main.tsx loads the mock only in dev with VITE_MOCK=1, and no page imports it', () => {
    const main = readFileSync(join(src, 'main.tsx'), 'utf8');
    expect(main).toMatch(/import\.meta\.env\.DEV && import\.meta\.env\.VITE_MOCK === '1'/);
    expect(main).not.toMatch(/^import .*['"]\.\/(?:mock|dev)\//m);
    for (const page of ['App.tsx', 'PlayRoom.tsx', 'Lobby.tsx', 'session.ts', 'room-api.ts', 'game-api.ts']) {
      expect(readFileSync(join(src, page), 'utf8')).not.toMatch(/['"]\.\/(?:mock|dev)\//);
    }
  });

  it('uninstall puts the real fetch and WebSocket back', () => {
    uninstall();
    const fetchBefore = globalThis.fetch;
    const wsBefore = globalThis.WebSocket;
    const off = installMock();
    expect(globalThis.fetch).not.toBe(fetchBefore);
    off();
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(globalThis.WebSocket).toBe(wsBefore);
    uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
  });
});
