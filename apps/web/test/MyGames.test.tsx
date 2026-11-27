// ISK-022: เกมของฉัน on the home page (the GEN-037 `isekai.knownSessions` list, one row per game) and back into a
// game whose session expired with the PIN only. C1 and C6 stub fetch; the rest run on the mock layer (`my-games*`).
import type { GameView } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { Gallery } from '../src/dev/Gallery.tsx';
import { installMock, mockBaseUrl } from '../src/mock/install.ts';
import { MY_GAMES, SCENARIOS, scenarioById } from '../src/mock/scenarios.ts';
import { KNOWN_TOKENS_KEY, loadKnownSessions, rememberSession, type KnownSession } from '../src/session.ts';

let uninstall: (() => void) | undefined;
let cell = 0;

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  uninstall?.();
  uninstall = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** The app on a mock scenario with `rows` kept in this browser (as stored, newest first). */
function onMock(scenario: string, rows: readonly KnownSession[] = scenarioById(scenario).myGames ?? []) {
  localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(rows));
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
  render(<App apiBaseUrl={mockBaseUrl(scenario, `c${++cell}`)} />);
}

const myGames = () => screen.findByRole('region', { name: 'เกมของฉัน' });
async function rowOf(name: string): Promise<HTMLElement> {
  return (await within(await myGames()).findByText(name)).closest('li')!;
}
/** The row once its status from GET /api/game is shown. */
async function rowWith(name: string, status: string): Promise<HTMLElement> {
  const row = await rowOf(name);
  await within(row).findByText(status);
  return row;
}

describe('C10 the stored list (session.ts)', () => {
  it('reads every token of the old string array, as rows with the token only', () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-a', 'tok-b']));
    expect(loadKnownSessions()).toEqual([{ token: 'tok-a' }, { token: 'tok-b' }]);
  });

  it('a broken stored value is an empty list, not an error', () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, '{oops');
    expect(loadKnownSessions()).toEqual([]);
  });

  it('a join of the same game again keeps 1 row with the new token, on top', () => {
    rememberSession({ token: 'tok-1', gameId: 'g-1', gameName: 'เกมแรก', inviteCode: 'AAA111', playerName: 'นก' });
    rememberSession({ token: 'tok-2', gameId: 'g-2' });
    rememberSession({ token: 'tok-1b', gameId: 'g-1' });
    const rows = loadKnownSessions()!;
    expect(rows.map((r) => r.token)).toEqual(['tok-1b', 'tok-2']);
    expect(rows[0]).toMatchObject({ gameId: 'g-1', gameName: 'เกมแรก', inviteCode: 'AAA111', playerName: 'นก' });
    expect(typeof rows[0]!.lastSeen).toBe('string');
  });

  it('ISK-024: a new round (new gameId) is a new row and the old round keeps its token', () => {
    rememberSession({ token: 'tok-r1', gameId: 'g-round1' });
    rememberSession({ token: 'tok-r2', gameId: 'g-round2' });
    expect(loadKnownSessions()!.map((r) => r.token)).toEqual(['tok-r2', 'tok-r1']);
  });

  it('an old token-only row gets its game when that token joins again (one row)', () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-old']));
    rememberSession({ token: 'tok-old', gameId: 'g-old', playerName: 'นก' });
    expect(loadKnownSessions()).toEqual([expect.objectContaining({ token: 'tok-old', gameId: 'g-old', playerName: 'นก' })]);
  });

  it('storage that throws reads as null (no list at all)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(loadKnownSessions()).toBeNull();
  });
});

describe('C1 two joins', () => {
  const view = (id: string, name: string, inviteCode: string): GameView => ({ ...(CONTRACT_FIXTURES.GameView[1] as GameView), id, name, inviteCode });
  const games: Record<string, GameView> = { 'tok-a': view('g-a', 'เกมแรก', 'AAA111'), 'tok-b': view('g-b', 'เกมสอง', 'BBB222') };

  it('two games in เกมของฉัน, the last joined first, and no PIN anywhere in localStorage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
        if (url.endsWith('/api/join')) {
          const { inviteCode } = JSON.parse(String(init?.body)) as { inviteCode: string };
          const [token, game] = Object.entries(games).find(([, g]) => g.inviteCode === inviteCode)!;
          return Response.json({ token, expiresAt: '2026-12-27T00:00:00.000Z', created: true, member: { id: 'm-1', gameId: game.id, name: 'นก' } });
        }
        const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
        if (url.endsWith('/api/game') && games[token]) return Response.json(games[token]);
        return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
      }),
    );
    render(<App apiBaseUrl="" />);
    for (const [code, name] of [['AAA111', 'เกมแรก'], ['BBB222', 'เกมสอง']] as const) {
      fireEvent.change(await screen.findByLabelText('โค้ดเกม'), { target: { value: code } });
      fireEvent.change(screen.getByLabelText('ชื่อผู้เล่น'), { target: { value: 'นก' } });
      fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4826' } });
      fireEvent.click(screen.getByRole('button', { name: 'เข้าร่วม' }));
      await screen.findByText(new RegExp(`${name} · Online`));
      fireEvent.click(screen.getByRole('button', { name: 'ออกจากเกม' }));
    }

    const items = within(await myGames()).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('เกมสอง');
    expect(items[1]!.textContent).toContain('เกมแรก');
    expect(loadKnownSessions()).toEqual([
      expect.objectContaining({ token: 'tok-b', gameId: 'g-b', gameName: 'เกมสอง', inviteCode: 'BBB222', playerName: 'นก' }),
      expect.objectContaining({ token: 'tok-a', gameId: 'g-a', gameName: 'เกมแรก', inviteCode: 'AAA111', playerName: 'นก' }),
    ]);
    for (let i = 0; i < localStorage.length; i++) {
      const stored = localStorage.getItem(localStorage.key(i)!)!;
      expect(stored).not.toMatch(/pin/i);
      expect(stored).not.toContain('"4826"');
    }
  });
});

describe('C11 / C12 / C7 each row says where its game is (GET /api/game with its own token)', () => {
  it('lobby / setup / playing day 3 / ended / closed, newest first', async () => {
    onMock('my-games');
    await rowWith(MY_GAMES.lobby.gameName!, 'รอเริ่ม');
    await rowWith(MY_GAMES.setup.gameName!, 'กำลังเตรียมตัว');
    await rowWith(MY_GAMES.playing.gameName!, 'กำลังเล่น วันที่ 3');
    await rowWith(MY_GAMES.ended.gameName!, 'จบแล้ว');
    await rowWith(MY_GAMES.closed.gameName!, 'ปิดโดยผู้ดูแล');
    const names = within(await myGames()).getAllByRole('listitem').map((li) => li.querySelector('strong')?.textContent);
    expect(names).toEqual(Object.values(MY_GAMES).map((r) => r.gameName));
  });

  it('C12: kicked = "ถูกเชิญออกจากเกมนี้" and no way in; a row that cannot connect says so with [ลองใหม่], the others still show', async () => {
    onMock('my-games');
    const kicked = await rowWith(MY_GAMES.kicked.gameName!, 'ถูกเชิญออกจากเกมนี้');
    expect(within(kicked).queryByRole('button', { name: 'เข้าเกม' })).toBeNull();
    expect(within(kicked).getByRole('button', { name: 'เอาออกจากรายการ' })).toBeTruthy();

    const offline = await rowWith(MY_GAMES.offline.gameName!, 'ต่อไม่ได้');
    expect(within(offline).queryByRole('button', { name: 'เข้าเกม' })).toBeNull();
    fireEvent.click(within(offline).getByRole('button', { name: 'ลองใหม่' }));
    expect(await within(offline).findByText('ต่อไม่ได้')).toBeTruthy();
    await rowWith(MY_GAMES.lobby.gameName!, 'รอเริ่ม');
  });

  it('C7: a game the server does not have (404) = "หาเกมไม่พบ" with [เอาออกจากรายการ], no way in', async () => {
    onMock('my-games');
    const gone = await rowWith(MY_GAMES.gone.gameName!, 'หาเกมไม่พบ');
    expect(within(gone).queryByRole('button', { name: 'เข้าเกม' })).toBeNull();
    expect(within(gone).getByRole('button', { name: 'เอาออกจากรายการ' })).toBeTruthy();
  });
});

describe('pressing a row opens the page of its phase', () => {
  it('C2: a game being played with a good token opens Play at once', async () => {
    onMock('my-games');
    fireEvent.click(within(await rowWith(MY_GAMES.playing.gameName!, 'กำลังเล่น วันที่ 3')).getByRole('button', { name: 'เข้าเกม' }));
    expect(await screen.findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'ห้องรอ' })).toBeNull();
  });

  it('C11: lobby opens the lobby', async () => {
    onMock('my-games');
    fireEvent.click(within(await rowWith(MY_GAMES.lobby.gameName!, 'รอเริ่ม')).getByRole('button', { name: 'เข้าเกม' }));
    expect(await screen.findByRole('region', { name: 'ห้องรอ' })).toBeTruthy();
  });

  it('C11: setup opens the character step', async () => {
    onMock('my-games');
    fireEvent.click(within(await rowWith(MY_GAMES.setup.gameName!, 'กำลังเตรียมตัว')).getByRole('button', { name: 'เข้าเกม' }));
    expect((await screen.findAllByRole('region', { name: 'สร้างตัวละคร' })).length).toBeGreaterThan(0);
  });

  it.each([
    ['ended', MY_GAMES.ended.gameName!, 'จบแล้ว'],
    ['closed', MY_GAMES.closed.gameName!, 'ปิดโดยผู้ดูแล'],
  ])('C4: a game that is %s opens its end page', async (_kind, name, status) => {
    onMock('my-games');
    fireEvent.click(within(await rowWith(name, status)).getByRole('button', { name: 'ดูสรุป' }));
    expect(await screen.findByRole('region', { name: /^สรุปเกม / })).toBeTruthy();
  });

  it('C3: 401 session_expired asks for the PIN only (code and name filled in); the right PIN goes back into the same game', async () => {
    onMock('my-games-expired');
    const row = await rowWith(MY_GAMES.expired.gameName!, 'session หมดอายุ ใส่ PIN เพื่อกลับเข้าเกม');
    fireEvent.click(within(row).getByRole('button', { name: 'เข้าเกม' }));

    await waitFor(() => expect((screen.getByLabelText('โค้ดเกม') as HTMLInputElement).value).toBe('K7Q2MX'));
    expect((screen.getByLabelText('ชื่อผู้เล่น') as HTMLInputElement).value).toBe('นก');
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้าร่วม' }));

    expect(await screen.findByText(new RegExp(`${MY_GAMES.expired.gameName} · Online`))).toBeTruthy();
    const rows = loadKnownSessions()!.filter((r) => r.gameId === MY_GAMES.expired.gameId);
    expect(rows).toEqual([expect.objectContaining({ token: 'mg-renewed', inviteCode: 'K7Q2MX', playerName: 'นก' })]);
  });

  it('C13: a wrong PIN in the filled form shows the error and keeps the code and the name', async () => {
    onMock('my-games-wrong-pin');
    fireEvent.click(within(await rowWith(MY_GAMES.expired.gameName!, 'session หมดอายุ ใส่ PIN เพื่อกลับเข้าเกม')).getByRole('button', { name: 'เข้าเกม' }));
    await waitFor(() => expect((screen.getByLabelText('โค้ดเกม') as HTMLInputElement).value).toBe('K7Q2MX'));
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้าร่วม' }));

    expect(await screen.findByText('PIN ไม่ถูกต้อง เหลือ 4 ครั้ง')).toBeTruthy();
    expect((screen.getByLabelText('โค้ดเกม') as HTMLInputElement).value).toBe('K7Q2MX');
    expect((screen.getByLabelText('ชื่อผู้เล่น') as HTMLInputElement).value).toBe('นก');
  });
});

describe('C5 / C6 the list on this device only', () => {
  it('C5: [เอาออกจากรายการ] drops the row from this device and says the game itself is still there', async () => {
    onMock('my-games');
    const row = await rowWith(MY_GAMES.lobby.gameName!, 'รอเริ่ม');
    fireEvent.click(within(row).getByRole('button', { name: 'เอาออกจากรายการ' }));

    await waitFor(() => expect(within(screen.getByRole('region', { name: 'เกมของฉัน' })).queryByText(MY_GAMES.lobby.gameName!)).toBeNull());
    expect(within(screen.getByRole('region', { name: 'เกมของฉัน' })).getByRole('status').textContent).toMatch(new RegExp(`${MY_GAMES.lobby.gameName}.*เกมยังอยู่`));
    expect(loadKnownSessions()!.some((r) => r.token === MY_GAMES.lobby.token)).toBe(false);
  });

  it('C6: storage that throws: the home page works and has no เกมของฉัน', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    render(<App apiBaseUrl={mockBaseUrl('guest', `c${++cell}`)} />);
    expect(await screen.findByRole('button', { name: 'เข้าร่วม' })).toBeTruthy();
    await screen.findByText('Server: ต่อได้ (database connected)');
    expect(screen.queryByRole('region', { name: 'เกมของฉัน' })).toBeNull();
  });

  it('an empty list says so', async () => {
    onMock('my-games-empty');
    expect(await within(await myGames()).findByText(/ยังไม่มีเกมในเครื่องนี้/)).toBeTruthy();
  });
});

describe('C8 390 px', () => {
  const src = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', file), 'utf8').replace(/\r\n/g, '\n');

  it('rows wrap instead of overflowing, every button is a 44 x 44 target, colours come from tokens', async () => {
    const css = src('pregame.css');
    expect(css).toMatch(/\.my-games__row \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.my-games \.btn \{[^}]*min-height: 44px;[^}]*min-width: 44px/);
    expect(src('MyGames.tsx')).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);

    onMock('my-games');
    const row = await rowWith(MY_GAMES.lobby.gameName!, 'รอเริ่ม');
    expect(row.className).toContain('my-games__row');
    for (const button of within(row).getAllByRole('button')) expect(button.className).toContain('btn');
  });
});

describe('C9 gallery', () => {
  it('has empty, several games, expired and error frames on the home screen', () => {
    const home = SCENARIOS.filter((s) => s.screens.includes('home')).map((s) => s.id);
    expect(home).toEqual(expect.arrayContaining(['my-games-empty', 'my-games', 'my-games-expired', 'my-games-error']));
  });

  it.each([
    ['my-games', MY_GAMES.playing.gameName!, 'กำลังเล่น วันที่ 3'],
    ['my-games-expired', MY_GAMES.expired.gameName!, 'session หมดอายุ ใส่ PIN เพื่อกลับเข้าเกม'],
    ['my-games-error', MY_GAMES.lobby.gameName!, 'ต่อไม่ได้'],
  ])('the %s frame lists its rows', async (scenario, name, status) => {
    uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    render(<Gallery search={`?screen=home&scenario=${scenario}`} />);
    await rowWith(name, status);
  });

  it('the my-games-empty frame says the list is empty', async () => {
    uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    render(<Gallery search="?screen=home&scenario=my-games-empty" />);
    expect(await within(await myGames()).findByText(/ยังไม่มีเกมในเครื่องนี้/)).toBeTruthy();
  });
});
