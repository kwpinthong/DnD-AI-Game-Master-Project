// ISK-016: joining a game that already started, on the web. C1 / C6 / C7 the join form's answers, C2-C5 / C8 the
// newcomer's setup (banner with the join day, no Play before the spawn, the crossing story first), C9 the old
// players' side, C10 the seat given back. Mock scenarios `join-*` and `late-join*` (src/mock/scenarios.ts).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { JoinForm } from '../src/JoinForm.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { installMock, MOCK_TOKEN, mockBaseUrl } from '../src/mock/install.ts';
import { PlayRoom } from '../src/PlayRoom.tsx';
import { TOKEN_KEY } from '../src/session.ts';
import { lateJoinText } from '../src/ui/strings.ts';

const noop = () => {};
let uninstall: () => void;
let cell = 0;
const base = (scenario: string) => mockBaseUrl(scenario, `lj${++cell}`);

beforeEach(() => {
  localStorage.clear();
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.restoreAllMocks();
  localStorage.clear();
});

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
function fill() {
  for (const [label, value] of [['โค้ดเกม', 'K7Q2MX'], ['ชื่อผู้เล่น', 'ปลา'], ['PIN', '1234']] as const) {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }
}
/** The join form against a stubbed POST /api/join. */
function joinAnswering(reply: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async () => reply());
  vi.stubGlobal('fetch', fetchMock);
  render(<JoinForm apiBaseUrl="" onJoined={noop} />);
  fill();
  return fetchMock;
}
const banner = () => screen.findByText(/คุณกำลังเข้าร่วมเกมที่เริ่มไปแล้ว/);
const lobby = (scenario: string, url = base(scenario)) => render(<Lobby apiBaseUrl={url} token={MOCK_TOKEN} onSessionLost={noop} pollMs={100} />);
/** From the loot step (the draft character has its loot kept) to the spawn step. */
async function toSpawnStep() {
  await screen.findByRole('list', { name: 'ของติดตัวที่เลือก' });
  fireEvent.click(button('ถัดไป: ตรวจทาน'));
  fireEvent.click(await screen.findByRole('button', { name: 'ยืนยันตัวละคร' }));
  return screen.findByRole('button', { name: 'เข้าเมือง' });
}

describe('C1 / C6 / C7 the join form says why a game cannot be joined', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['join_closed_day', 'เกมผ่านวันที่ 9 แล้ว เข้าร่วมไม่ได้'],
    ['single_mode', 'เกมนี้เล่นคนเดียว'],
    ['game_ended', 'เกมนี้จบแล้ว'],
  ])('C1: %s shows "%s"', async (code, text) => {
    joinAnswering(() => Response.json({ code, message: 'server wording' }, { status: 409 }));
    fireEvent.click(button('เข้าร่วม'));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
  });

  it('C6: a code the web does not know says "เข้าร่วมไม่ได้ ลองใหม่ภายหลัง"', async () => {
    joinAnswering(() => Response.json({ code: 'brand_new_reason', message: 'อะไรสักอย่าง' }, { status: 409 }));
    fireEvent.click(button('เข้าร่วม'));
    expect((await screen.findByRole('alert')).textContent).toBe('เข้าร่วมไม่ได้ ลองใหม่ภายหลัง');
  });

  it('C6: 403 kicked keeps the server message (regression)', async () => {
    const message = 'ชื่อนี้ถูกเจ้าของเกมเชิญออกแล้ว เข้าเกมนี้อีกไม่ได้';
    joinAnswering(() => Response.json({ code: 'kicked', message }, { status: 403 }));
    fireEvent.click(button('เข้าร่วม'));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });

  it('C7: a second press while joining sends nothing more, and the button says it is busy', async () => {
    let answer: (r: Response) => void = noop;
    const fetchMock = joinAnswering(() => new Promise<Response>((resolve) => (answer = resolve)));
    fireEvent.click(button('เข้าร่วม'));
    fireEvent.click(button(/เข้าร่วม/));
    fireEvent.click(button(/เข้าร่วม/));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('กำลังเข้าร่วม…')).toBeTruthy();
    answer(Response.json({ code: 'game_full', message: 'เกมเต็ม (เกมนี้เล่นคนเดียว)' }, { status: 409 }));
    expect(await screen.findByText('เกมเต็ม (เกมนี้เล่นคนเดียว)')).toBeTruthy();
  });

  it('C6: joining before the start keeps the old flow: the lobby, no mid-game banner', async () => {
    lobby('lobby');
    expect(await screen.findByRole('list', { name: 'สมาชิก' })).toBeTruthy();
    expect(screen.queryByText(/คุณกำลังเข้าร่วมเกมที่เริ่มไปแล้ว/)).toBeNull();
  });
});

// ISK-030: game_full shows the server's own message (solo game vs a full multiplayer game), not a web string.
describe('ISK-030 game_full ใช้ข้อความ server', () => {
  afterEach(() => vi.unstubAllGlobals());
  const here = dirname(fileURLToPath(import.meta.url));
  const src = (file: string) => readFileSync(join(here, '..', 'src', file), 'utf8');

  it('ISK-030 C1: a 409 game_full shows the server message, not "ห้องเต็มแล้ว (6 คน)"', async () => {
    joinAnswering(() => Response.json({ code: 'game_full', message: 'เกมเต็ม (เกมนี้เล่นคนเดียว)' }, { status: 409 }));
    fireEvent.click(button('เข้าร่วม'));
    expect((await screen.findByRole('alert')).textContent).toBe('เกมเต็ม (เกมนี้เล่นคนเดียว)');
    expect(screen.queryByText('ห้องเต็มแล้ว (6 คน)')).toBeNull();
  });

  it('ISK-030 C2: the multiplayer wording of the server shows as is', async () => {
    joinAnswering(() => Response.json({ code: 'game_full', message: 'เกมเต็ม (ผู้เล่นครบ 4 คนแล้ว)' }, { status: 409 }));
    fireEvent.click(button('เข้าร่วม'));
    expect((await screen.findByRole('alert')).textContent).toBe('เกมเต็ม (ผู้เล่นครบ 4 คนแล้ว)');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('ISK-030 C3: the other codes keep the web words, kicked keeps the server message', async () => {
    const rows: [number, string, string, string][] = [
      [409, 'join_closed_day', 'server wording', 'เกมผ่านวันที่ 9 แล้ว เข้าร่วมไม่ได้'],
      [409, 'single_mode', 'server wording', 'เกมนี้เล่นคนเดียว'],
      [409, 'game_ended', 'server wording', 'เกมนี้จบแล้ว'],
      [409, 'brand_new_reason', 'อะไรสักอย่าง', 'เข้าร่วมไม่ได้ ลองใหม่ภายหลัง'],
      [403, 'kicked', 'ชื่อนี้ถูกเจ้าของเกมเชิญออกแล้ว เข้าเกมนี้อีกไม่ได้', 'ชื่อนี้ถูกเจ้าของเกมเชิญออกแล้ว เข้าเกมนี้อีกไม่ได้'],
    ];
    for (const [status, code, message, shown] of rows) {
      joinAnswering(() => Response.json({ code, message }, { status }));
      fireEvent.click(button('เข้าร่วม'));
      expect((await screen.findByRole('alert')).textContent).toBe(shown);
      cleanup();
    }
  });

  it('ISK-030 C4: the mock scenario join-game-full answers the solo wording', async () => {
    render(<JoinForm apiBaseUrl={base('join-game-full')} onJoined={noop} />);
    fill();
    fireEvent.click(button('เข้าร่วม'));
    expect((await screen.findByRole('alert')).textContent).toBe('เกมเต็ม (เกมนี้เล่นคนเดียว)');
  });

  it('ISK-030 C5: no web string for game_full is left', () => {
    expect('game_full' in lateJoinText.errors).toBe(false);
    for (const file of ['session.ts', 'ui/strings.ts', 'mock/scenarios.ts']) expect(src(file)).not.toContain('ห้องเต็มแล้ว (6 คน)');
  });
});

describe('C2-C5 / C8 the newcomer prepares before Play', () => {
  it('C2: joined on day 4 → the character steps with the banner "วันที่ 4"', async () => {
    lobby('late-join');
    expect((await banner()).textContent).toBe('คุณกำลังเข้าร่วมเกมที่เริ่มไปแล้ว (วันที่ 4)');
    expect(await screen.findByRole('navigation', { name: 'ขั้นตอนสร้างตัวละคร' })).toBeTruthy();
    // no lobby behind them: no "back to the lobby"
    expect(screen.queryByRole('button', { name: 'กลับห้องรอ' })).toBeNull();
  });

  it('C3: not spawned yet → no Play and no way into it; opened again it is the setup again', async () => {
    const url = base('late-join');
    const first = lobby('late-join', url);
    await banner();
    expect(screen.queryByRole('button', { name: 'เข้าห้องเล่น' })).toBeNull();
    expect(screen.queryByText('เชื่อมต่อแล้ว')).toBeNull();
    first.unmount();

    lobby('late-join', url);
    await banner();
    expect(await screen.findByRole('navigation', { name: 'ขั้นตอนสร้างตัวละคร' })).toBeTruthy();
    expect(screen.queryByText('เชื่อมต่อแล้ว')).toBeNull();
  });

  it('C8: refreshed at the spawn step → the spawn step again, the banner still says the join day (not today)', async () => {
    const first = lobby('late-join');
    await banner();
    await toSpawnStep();
    first.unmount();

    // the game went on to day 5 meanwhile
    lobby('late-join-next-day');
    expect(await screen.findByRole('button', { name: 'เข้าเมือง' })).toBeTruthy();
    expect((await banner()).textContent).toBe('คุณกำลังเข้าร่วมเกมที่เริ่มไปแล้ว (วันที่ 4)');
  });

  it('C4: spawned → Play opens with the crossing story and the story so far first', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    lobby('late-join');
    await banner();
    fireEvent.click(await toSpawnStep());

    const card = await screen.findByRole('dialog', { name: 'จุดเกิดของคุณ' });
    const story = await within(card).findByText(/คุณลืมตาขึ้นท่ามกลางกองจานสกปรก/);
    expect(story.textContent).toContain('เรื่องราวก่อนคุณมาถึง: สามวันก่อน หอนาฬิกากลางเมืองหยุดเดิน');
    expect(fetchSpy.mock.calls.filter(([u, init]) => String(u).endsWith('/api/game/spawn') && init?.method === 'POST')).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'เริ่มเล่น' }));
    expect(await screen.findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    expect(screen.queryByText(/คุณกำลังเข้าร่วมเกมที่เริ่มไปแล้ว/)).toBeNull();
  });

  it('C5: at 390 px the banner wraps inside the page (no fixed width, long words break)', async () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pregame.css'), 'utf8');
    lobby('late-join');
    const shown = await banner();
    expect(shown.closest('.pregame')).toBeTruthy();
    const rule = /\.late-join\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).not.toMatch(/(?:^|[\s;])(?:min-)?width:\s*\d+px/);
  });
});

describe('C9 the old players see the newcomer arrive', () => {
  it('the feed says someone new arrived by look, and the people list has their look', async () => {
    render(<PlayRoom apiBaseUrl={base('late-join-arrival')} token={MOCK_TOKEN} onBack={noop} onGameList={noop} onNeedCharacter={noop} onSessionLost={noop} />);
    const feed = within(await screen.findByRole('region', { name: 'เหตุการณ์ที่นี่' }));
    expect(await feed.findByText(/มีผู้มาใหม่ปรากฏตัวในเมือง: คนแปลกหน้า หญิงผมสั้นสีเงิน/)).toBeTruthy();
    // the info panel's people tab (แผงข้อมูล → คนรอบตัว): their title (no name: nobody knows them yet) and look
    const panel = within(await screen.findByRole('complementary', { name: 'แผงข้อมูล' }));
    fireEvent.click(panel.getByRole('tab', { name: 'คนรอบตัว' }));
    const people = await panel.findByRole('list', { name: 'คนที่อยู่ที่นี่' });
    await waitFor(() => expect(people.textContent).toContain('หญิงผมสั้นสีเงิน เสื้อคลุมเดินทางสีเขียว'));
    expect(people.textContent).toContain('คนแปลกหน้า');
  });
});

describe('C10 the seat was given back', () => {
  it('while preparing: back to the join form with "หมดเวลาเตรียมตัว กรุณาเข้าร่วมใหม่"', { timeout: 10_000 }, async () => {
    // real time here: the session goes 1 s after the first request, after the setup has shown
    uninstall();
    uninstall = installMock({ timeScale: 1, latencyMs: 0 });
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);
    render(<App apiBaseUrl={base('late-join-expired')} />);
    await banner();
    expect(await screen.findByText('หมดเวลาเตรียมตัว กรุณาเข้าร่วมใหม่', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByLabelText('PIN')).toBeTruthy();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
