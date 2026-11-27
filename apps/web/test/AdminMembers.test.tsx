// ISK-020: the admin เกม tab's player panel (ISK-018's members / kick / new invite code). C1 the panel and its
// states, C2-C3 + C9 the kick, C4 + C9 + C10 the new code, C5 ended games, C6 401, C7 390 px, C8 gallery, C11 races.
import type { AdminGameRow, AdminMemberRow } from '@isekai/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_TOKEN_KEY, AdminDashboard } from '../src/AdminDashboard.tsx';
import { Gallery } from '../src/dev/Gallery.tsx';
import { installMock } from '../src/mock/install.ts';
import { scenarioById } from '../src/mock/scenarios.ts';

const row = (r: Partial<AdminGameRow> = {}): AdminGameRow => ({
  id: 'g-play',
  name: 'ทดสอบ',
  phase: 'playing',
  endedReason: null,
  day: 4,
  period: 'EOSORIA',
  playerCount: 3,
  lastActionAt: '2026-11-23T08:00:00.000Z',
  aiUsd: 0.42,
  ...r,
});

const GAMES: AdminGameRow[] = [
  row({ id: 'g-lobby', name: 'ห้องรอ', phase: 'lobby', day: null, period: null, playerCount: 2, lastActionAt: null, aiUsd: 0 }),
  row(),
  row({ id: 'g-finale', name: 'จบตามเรื่อง', phase: 'ended', endedReason: 'finale', day: 12, period: 'NOCTHERION' }),
  row({ id: 'g-over', name: 'ตายหมด', phase: 'ended', endedReason: 'game_over', day: 7, period: 'SOLARION' }),
  row({ id: 'g-closed', name: 'ปิดแล้ว', phase: 'ended', endedReason: 'closed', day: 2, period: 'SOLARION' }),
];

const member = (m: Partial<AdminMemberRow>): AdminMemberRow => ({ id: 'm-1', name: 'นก', role: 'player', hasCharacter: true, ready: true, kickedAt: null, ...m });
const MEMBERS: AdminMemberRow[] = [
  member({ id: 'm-gm', name: 'จีเอ็ม', role: 'gm', hasCharacter: false, ready: false }),
  member({}),
  member({ id: 'm-2', name: 'บี', hasCharacter: false, ready: false, kickedAt: '2026-11-24T10:00:00.000Z' }),
];
const KICKED_NOK = MEMBERS.map((m) => (m.id === 'm-1' ? { ...m, kickedAt: '2026-11-24T11:00:00.000Z' } : m));
const CODE = 'K7Q2MX';
const SHOWN_CODE = 'K7Q-2MX';

type Reply = Response | Promise<Response>;
interface Call {
  method: string;
  path: string;
}

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

const fail = (status: number, code: string, message: string) => () => Response.json({ code, message }, { status });

/** The admin server: the game list, each game's members (`members(gameId, n)` = its n-th load), the kick and the new code. */
function server({
  members = () => Response.json({ members: MEMBERS }),
  kick,
  invite,
}: { members?: (gameId: string, n: number) => Reply; kick?: () => Reply; invite?: () => Reply } = {}) {
  const calls: Call[] = [];
  const loads = new Map<string, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      if (method === 'GET' && path === '/api/admin/games') return Response.json({ games: GAMES });
      const of = /^\/api\/admin\/games\/([^/]+)\/members$/.exec(path);
      if (method === 'GET' && of) {
        const n = loads.get(of[1]!) ?? 0;
        loads.set(of[1]!, n + 1);
        return members(of[1]!, n);
      }
      if (method === 'POST' && /\/members\/[^/]+\/kick$/.test(path) && kick) return kick();
      if (method === 'POST' && /\/invite-code$/.test(path) && invite) return invite();
      return Response.json({ code: 'game_not_found', message: 'ไม่พบเกมนี้' }, { status: 404 });
    }),
  );
  return calls;
}

async function openTab() {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, 'adm-1');
  render(<AdminDashboard apiBaseUrl="http://api" />);
  fireEvent.click(screen.getByRole('button', { name: 'เกม' }));
  await screen.findByRole('table', { name: 'รายการเกม' });
}
const openGame = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const panel = (name = 'ทดสอบ') => screen.findByRole('region', { name: `ผู้เล่นในเกม ${name}` });
const memberRow = (p: HTMLElement, name: string) => within(p).getByRole('row', { name: new RegExp(name) });
const cell = (r: HTMLElement, label: string) => r.querySelector(`[data-label="${label}"]`)!.textContent;
const dialog = () => screen.getByRole('alertdialog');
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('C1 the player panel', () => {
  it('a game row opens its players: name, role, character, ready, kicked', async () => {
    const calls = server();
    await openTab();
    openGame('ทดสอบ');
    const p = await panel();
    await within(p).findByRole('table');
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/games/g-play/members')).toHaveLength(1);
    const gm = memberRow(p, 'จีเอ็ม');
    expect(cell(gm, 'บทบาท')).toBe('GM');
    expect(cell(gm, 'ตัวละคร')).toBe('ยังไม่มี');
    expect(cell(gm, 'สถานะ')).toBe('อยู่ในเกม');
    const nok = memberRow(p, 'นก');
    expect(cell(nok, 'บทบาท')).toBe('ผู้เล่น');
    expect(cell(nok, 'ตัวละคร')).toBe('มีแล้ว');
    expect(cell(nok, 'พร้อม')).toBe('พร้อม');
    expect(cell(nok, 'สถานะ')).toBe('อยู่ในเกม');
    const b = memberRow(p, 'บี');
    expect(cell(b, 'พร้อม')).toBe('ยังไม่พร้อม');
    expect(cell(b, 'สถานะ')).toBe('ถูกเตะแล้ว');
    // the game list is still there
    expect(screen.getByRole('table', { name: 'รายการเกม' })).toBeTruthy();
  });

  it('opens and closes in a browser whose scrollIntoView answers a Promise (Chrome): the page does not crash', async () => {
    const scroll = vi.fn(() => Promise.resolve());
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scroll, configurable: true });
    try {
      server();
      await openTab();
      openGame('ทดสอบ');
      await within(await panel()).findByRole('row', { name: /นก/ });
      expect(scroll).toHaveBeenCalled();
      openGame('ทดสอบ');
      expect(screen.queryByRole('region', { name: 'ผู้เล่นในเกม ทดสอบ' })).toBeNull();
      expect(screen.getByRole('table', { name: 'รายการเกม' })).toBeTruthy();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('loading while the players have not come', async () => {
    server({ members: () => new Promise<Response>(() => {}) });
    await openTab();
    openGame('ทดสอบ');
    expect(await within(await panel()).findByRole('status', { name: 'กำลังโหลดรายชื่อผู้เล่น…' })).toBeTruthy();
  });

  it('an error with [ลองอีกครั้ง] that loads again', async () => {
    const calls = server({ members: (_id, n) => (n === 0 ? Promise.reject(new TypeError('Failed to fetch')) : Response.json({ members: MEMBERS })) });
    await openTab();
    openGame('ทดสอบ');
    const p = await panel();
    fireEvent.click(within(await within(p).findByRole('alert')).getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(await within(p).findByRole('row', { name: /นก/ })).toBeTruthy();
    expect(calls.filter((c) => c.path === '/api/admin/games/g-play/members')).toHaveLength(2);
  });

  it('empty: says the game has no player', async () => {
    server({ members: () => Response.json({ members: [] }) });
    await openTab();
    openGame('ทดสอบ');
    expect(await within(await panel()).findByText('เกมนี้ยังไม่มีผู้เล่น')).toBeTruthy();
  });
});

async function kickNok(opts: Parameters<typeof server>[0]) {
  const calls = server(opts);
  await openTab();
  openGame('ทดสอบ');
  const p = await panel();
  fireEvent.click(await within(p).findByRole('button', { name: 'เตะ นก' }));
  return { calls, p };
}
const kickConfirm = () => within(dialog()).getByRole('button', { name: /ยืนยันเตะ|กำลัง/ }) as HTMLButtonElement;

describe('C2 the kick', () => {
  it('the box says the name cannot come back; one request however often it is pressed; success marks the row kicked', async () => {
    const answer = deferred();
    const { calls, p } = await kickNok({ kick: () => answer.promise });
    expect(dialog().textContent).toContain('นก');
    expect(dialog().textContent).toContain('เข้าเกมนี้ใหม่ด้วยชื่อนี้ไม่ได้');
    const confirm = kickConfirm();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.path).toBe('/api/admin/games/g-play/members/m-1/kick');
    expect(kickConfirm().disabled).toBe(true);

    await act(async () => answer.resolve(Response.json({ members: KICKED_NOK })));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cell(memberRow(p, 'นก'), 'สถานะ')).toBe('ถูกเตะแล้ว');
    expect(within(p).queryByRole('button', { name: 'เตะ นก' })).toBeNull();
    expect(posts(calls)).toHaveLength(1);
  });

  it('no kick button on a member already kicked', async () => {
    server();
    await openTab();
    openGame('ทดสอบ');
    const p = await panel();
    await within(p).findByRole('button', { name: 'เตะ นก' });
    expect(within(p).queryByRole('button', { name: 'เตะ บี' })).toBeNull();
  });
});

describe('C3 409 already_kicked', () => {
  it('the message is in the box; the row stays as it was until a reload', async () => {
    const { p } = await kickNok({ kick: fail(409, 'already_kicked', 'ผู้เล่นคนนี้ถูกเชิญออกไปแล้ว') });
    fireEvent.click(kickConfirm());
    expect((await within(dialog()).findByRole('alert')).textContent).toContain('ผู้เล่นคนนี้ถูกเชิญออกไปแล้ว');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'ยกเลิก' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(cell(memberRow(p, 'นก'), 'สถานะ')).toBe('อยู่ในเกม');
    expect(within(p).getByRole('button', { name: 'เตะ นก' })).toBeTruthy();
  });
});

describe('C9 the other answers of the kick and the new code', () => {
  it.each([
    [404, 'member_not_found', 'ไม่พบผู้เล่นคนนี้ในเกมนี้'],
    [409, 'already_ended', 'เกมนี้จบหรือถูกปิดไปแล้ว'],
    [409, 'not_allowed', 'เชิญ GM ของเกมออกไม่ได้ เกมจะค้างรอ GM อนุมัติ'],
  ])('kick %i %s: the message is in the box', async (status, code, message) => {
    await kickNok({ kick: fail(status, code, message) });
    fireEvent.click(kickConfirm());
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(message);
    expect(kickConfirm().disabled).toBe(false);
  });

  it('new code 409 already_ended: the message is in the box, no code', async () => {
    await askNewCode({ invite: fail(409, 'already_ended', 'เกมนี้จบหรือถูกปิดไปแล้ว') });
    fireEvent.click(inviteConfirm());
    expect((await within(dialog()).findByRole('alert')).textContent).toContain('เกมนี้จบหรือถูกปิดไปแล้ว');
  });

  it('[ออกรหัสเชิญใหม่] pressed again and again sends once', async () => {
    const answer = deferred();
    const { calls } = await askNewCode({ invite: () => answer.promise });
    const confirm = inviteConfirm();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.path).toBe('/api/admin/games/g-play/invite-code');
    expect(inviteConfirm().disabled).toBe(true);
    await act(async () => answer.resolve(Response.json({ inviteCode: CODE })));
    expect(await screen.findByDisplayValue(SHOWN_CODE)).toBeTruthy();
    expect(posts(calls)).toHaveLength(1);
  });
});

async function askNewCode(opts: Parameters<typeof server>[0]) {
  const calls = server(opts);
  await openTab();
  openGame('ทดสอบ');
  const p = await panel();
  fireEvent.click(await within(p).findByRole('button', { name: 'ออกรหัสเชิญใหม่' }));
  return { calls, p };
}
const inviteConfirm = () => within(dialog()).getByRole('button', { name: /ยืนยันออกรหัสใหม่|กำลัง/ }) as HTMLButtonElement;
const codeBox = () => screen.getByDisplayValue(SHOWN_CODE) as HTMLInputElement;
const stored = () => [sessionStorage, localStorage].flatMap((s) => Object.keys(s).map((k) => s.getItem(k) ?? '')).join('\n');

describe('C4 the new invite code', () => {
  it('the box says the old code stops at once; the new code shows once with copy; closed = gone and not stored', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await askNewCode({ invite: () => Response.json({ inviteCode: CODE }) });
    expect(dialog().textContent).toContain('รหัสเชิญเดิมจะใช้ไม่ได้ทันที');
    fireEvent.click(inviteConfirm());
    expect(await screen.findByDisplayValue(SHOWN_CODE)).toBeTruthy();
    const box = screen.getByRole('dialog', { name: 'รหัสเชิญใหม่' });
    fireEvent.click(within(box).getByRole('button', { name: 'คัดลอก' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHOWN_CODE));
    expect(await within(box).findByText('คัดลอกแล้ว')).toBeTruthy();

    fireEvent.click(within(box).getByRole('button', { name: 'ปิด' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain(SHOWN_CODE);
    expect(screen.queryByDisplayValue(SHOWN_CODE)).toBeNull();
    // the panel closed and opened again
    openGame('ทดสอบ');
    expect(screen.queryByRole('region', { name: 'ผู้เล่นในเกม ทดสอบ' })).toBeNull();
    openGame('ทดสอบ');
    await within(await panel()).findByRole('table');
    expect(screen.queryByDisplayValue(SHOWN_CODE)).toBeNull();
    expect(document.body.innerHTML).not.toContain(CODE);
    expect(document.body.innerHTML).not.toContain(SHOWN_CODE);
    expect(stored()).not.toContain(CODE);
    expect(stored()).not.toContain(SHOWN_CODE);
  });
});

describe('C10 no clipboard', () => {
  it.each([
    ['missing', undefined],
    ['refused', { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }],
    ['never answering', { writeText: () => new Promise<void>(() => {}) }],
  ])('clipboard %s: the code is selected (with "คัดลอกเอง" once it fails); it never goes to the console or the URL', async (what, clipboard) => {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    await askNewCode({ invite: () => Response.json({ inviteCode: CODE }) });
    fireEvent.click(inviteConfirm());
    await screen.findByDisplayValue(SHOWN_CODE);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'รหัสเชิญใหม่' })).getByRole('button', { name: 'คัดลอก' }));
    if (what !== 'never answering') expect(await screen.findByText(/คัดลอกเอง/)).toBeTruthy();
    const box = codeBox();
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(SHOWN_CODE.length);
    for (const spy of logs) for (const args of spy.mock.calls) expect(JSON.stringify(args.map(String))).not.toMatch(/K7Q-?2MX/);
    expect(window.location.href).not.toMatch(/K7Q-?2MX/);
  });
});

describe('C5 an ended game', () => {
  it.each([
    ['จบตามเรื่อง', 'finale'],
    ['ตายหมด', 'game_over'],
    ['ปิดแล้ว', 'closed'],
  ])('%s (%s): the players show without kick or new code', async (name) => {
    server();
    await openTab();
    openGame(name);
    const p = await panel(name);
    await within(p).findByRole('row', { name: /นก/ });
    expect(within(p).queryByRole('button', { name: /^เตะ/ })).toBeNull();
    expect(within(p).queryByRole('button', { name: 'ออกรหัสเชิญใหม่' })).toBeNull();
  });

  it('a lobby game has both', async () => {
    server();
    await openTab();
    openGame('ห้องรอ');
    const p = await panel('ห้องรอ');
    expect(await within(p).findByRole('button', { name: 'เตะ นก' })).toBeTruthy();
    expect(within(p).getByRole('button', { name: 'ออกรหัสเชิญใหม่' })).toBeTruthy();
  });
});

describe('C6 401 goes to the admin code page', () => {
  const unauthorized = fail(401, 'unauthorized', 'หน้านี้สำหรับเจ้าของ server เท่านั้น เข้าด้วย admin code ก่อน');

  it('on the players', async () => {
    server({ members: unauthorized });
    await openTab();
    openGame('ทดสอบ');
    expect(await screen.findByLabelText('admin code')).toBeTruthy();
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
  });

  it('on the kick', async () => {
    await kickNok({ kick: unauthorized });
    fireEvent.click(kickConfirm());
    expect(await screen.findByLabelText('admin code')).toBeTruthy();
  });

  it('on the new code', async () => {
    await askNewCode({ invite: unauthorized });
    fireEvent.click(inviteConfirm());
    expect(await screen.findByLabelText('admin code')).toBeTruthy();
  });
});

describe('C11 a quick switch of game', () => {
  it('game A is pressed then game B before A loads: only B shows', async () => {
    const a = deferred();
    server({ members: (id) => (id === 'g-play' ? a.promise : Response.json({ members: [member({ id: 'm-9', name: 'ลิน' })] })) });
    await openTab();
    openGame('ทดสอบ');
    openGame('ห้องรอ');
    const p = await panel('ห้องรอ');
    await within(p).findByRole('row', { name: /ลิน/ });
    await act(async () => a.resolve(Response.json({ members: MEMBERS })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('region', { name: 'ผู้เล่นในเกม ทดสอบ' })).toBeNull();
    expect(screen.queryByText('นก')).toBeNull();
    expect(within(p).getByRole('row', { name: /ลิน/ })).toBeTruthy();
  });
});

describe('C7 390 px', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const css = readFileSync(join(dir, 'library.css'), 'utf8');

  it('the players are cards like the game list, every button is 44 x 44, the code box fits the dialog', async () => {
    server();
    await openTab();
    openGame('ทดสอบ');
    const p = await panel();
    // the players table is an `.agames` table: cards below 768 px (ISK-002 C8), buttons 44 x 44
    expect((await within(p).findByRole('table')).classList.contains('agames')).toBe(true);
    expect(css).toMatch(/\.amembers__head \.btn[^{]*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/);
    expect(css).toMatch(/\.invite-code[^{]*\{[^}]*min-height:\s*44px[^}]*\}/);
    expect(css).toMatch(/\.invite-code[^{]*\{[^}]*(?:max-width|width):\s*100%/);
    // the dialogs are the house dialog: min(100%, 440px), actions wrap and are 44 high
    const dialogCss = readFileSync(join(dir, 'ui', 'confirm-dialog.css'), 'utf8');
    expect(dialogCss).toMatch(/\.dialog \{[^}]*width:\s*min\(100%/);
    expect(dialogCss).toMatch(/\.dialog__actions \{[^}]*flex-wrap:\s*wrap/);
  });
});

describe('C8 the gallery', () => {
  it('has every state of C1-C6 on the admin-games screen', () => {
    for (const id of ['admin-members', 'admin-members-loading', 'admin-members-error', 'admin-members-empty', 'admin-kick-error', 'admin-invite-error', 'admin-members-unauthorized']) {
      const s = scenarioById(id);
      expect(s.id).toBe(id);
      expect(s.screens).toContain('admin-games');
    }
  });

  it('admin-members: a game opens its players; the kick marks the row; the new code shows', async () => {
    const uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    try {
      render(<Gallery search="?screen=admin-games&scenario=admin-members" />);
      await screen.findByRole('table', { name: 'รายการเกม' });
      fireEvent.click(screen.getAllByRole('button', { name: 'เมืองก่อนอุกกาบาต' })[0]!);
      const p = await panel('เมืองก่อนอุกกาบาต');
      fireEvent.click(await within(p).findByRole('button', { name: 'เตะ นก' }));
      fireEvent.click(kickConfirm());
      await waitFor(() => expect(cell(memberRow(p, 'นก'), 'สถานะ')).toBe('ถูกเตะแล้ว'));
      fireEvent.click(within(p).getByRole('button', { name: 'ออกรหัสเชิญใหม่' }));
      fireEvent.click(inviteConfirm());
      expect(await screen.findByDisplayValue(SHOWN_CODE)).toBeTruthy();
    } finally {
      uninstall();
    }
  });

  it('admin-members-unauthorized: the frame goes to the admin code page', async () => {
    const uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    try {
      render(<Gallery search="?screen=admin-games&scenario=admin-members-unauthorized" />);
      await screen.findByRole('table', { name: 'รายการเกม' });
      fireEvent.click(screen.getAllByRole('button', { name: 'เมืองก่อนอุกกาบาต' })[0]!);
      expect(await screen.findByLabelText('admin code')).toBeTruthy();
    } finally {
      uninstall();
    }
  });
});
