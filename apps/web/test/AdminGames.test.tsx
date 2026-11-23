// ISK-002: the admin page's เกม tab (list every game + close one). C1 list / loading / error / empty, C2 the
// confirm dialog, C3 sending once + the answers, C8 cards at 390 px + every state in the gallery.
import type { AdminGameRow } from '@isekai/protocol';
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

const FOUR: AdminGameRow[] = [
  row({ id: 'g-lobby', name: 'ห้องรอ', phase: 'lobby', day: null, period: null, playerCount: 2, lastActionAt: null, aiUsd: 0 }),
  row({ id: 'g-setup', name: 'เตรียมตัว', phase: 'setup', day: null, period: null }),
  row(),
  row({ id: 'g-end', name: 'จบไปแล้ว', phase: 'ended', endedReason: 'finale', day: 12, period: 'NOCTHERION' }),
];

type Reply = Response | Promise<Response>;
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** The admin server: GET /api/admin/games answers `list()` in turn, POST close answers `close()`; the rest 404. */
function server({ list = [() => Response.json({ games: FOUR })], close }: { list?: (() => Reply)[]; close?: () => Reply } = {}) {
  const calls: Call[] = [];
  let lists = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET' && path === '/api/admin/games') return list[Math.min(lists++, list.length - 1)]!();
      if (method === 'POST' && /^\/api\/admin\/games\/[^/]+\/close$/.test(path) && close) return close();
      return Response.json({ code: 'game_not_found', message: 'ไม่พบ' }, { status: 404 });
    }),
  );
  return calls;
}

function openTab() {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, 'adm-1');
  render(<AdminDashboard apiBaseUrl="http://api" />);
  fireEvent.click(screen.getByRole('button', { name: 'เกม' }));
}

const table = () => screen.findByRole('table', { name: 'รายการเกม' });
const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
const dialog = () => screen.getByRole('alertdialog');
const confirmButton = () => within(dialog()).getByRole('button', { name: /ยืนยันปิดเกม|กำลัง/ }) as HTMLButtonElement;
const typeName = (value: string) => fireEvent.change(within(dialog()).getByLabelText('พิมพ์ชื่อเกมเพื่อยืนยัน'), { target: { value } });
const closes = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('C1 the game list', () => {
  it('4 games: the status in words, - for no day, [ปิดเกม] only on the 3 not ended', async () => {
    server();
    openTab();
    const t = await table();
    expect(within(t).getAllByRole('row').slice(1)).toHaveLength(4);
    expect(rowOf('ห้องรอ').textContent).toContain('รอเริ่ม');
    expect(rowOf('เตรียมตัว').textContent).toContain('กำลังเตรียมตัว');
    expect(rowOf('ทดสอบ').textContent).toContain('กำลังเล่น');
    expect(rowOf('จบไปแล้ว').textContent).toContain('จบแล้ว');
    expect(rowOf('ห้องรอ').querySelector('[data-label="วันในเกม"]')!.textContent).toBe('-');
    expect(rowOf('ทดสอบ').textContent).toContain('วันที่ 4');
    expect(rowOf('ทดสอบ').textContent).toContain('$0.42');
    for (const name of ['ห้องรอ', 'เตรียมตัว', 'ทดสอบ']) expect(screen.getByRole('button', { name: `ปิดเกม ${name}` })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ปิดเกม จบไปแล้ว' })).toBeNull();
    // the server's order is kept
    expect(within(t).getAllByRole('row').slice(1).map((r) => r.querySelector('th, td')!.textContent)).toEqual(['ห้องรอ', 'เตรียมตัว', 'ทดสอบ', 'จบไปแล้ว']);
  });

  it('loading while the list has not come', async () => {
    server({ list: [() => new Promise<Response>(() => {})] });
    openTab();
    expect(await screen.findByRole('status', { name: 'กำลังโหลดรายการเกม…' })).toBeTruthy();
  });

  it('an error with [ลองใหม่] that loads again', async () => {
    const calls = server({ list: [() => Promise.reject(new TypeError('Failed to fetch')), () => Response.json({ games: FOUR })] });
    openTab();
    const alert = await screen.findByRole('alert');
    // the house ErrorState's retry (uiText.error.retry)
    fireEvent.click(within(alert).getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(await table()).toBeTruthy();
    expect(calls.filter((c) => c.path === '/api/admin/games')).toHaveLength(2);
  });

  it('empty: says there is no game yet', async () => {
    server({ list: [() => Response.json({ games: [] })] });
    openTab();
    expect(await screen.findByText('ยังไม่มีเกม')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'รายการเกม' })).toBeNull();
  });
});

describe('C2 the confirm dialog', () => {
  it('confirm stays off until the name matches (trim); the reason stops at 200 with a counter', async () => {
    server();
    openTab();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'ปิดเกม ทดสอบ' }));
    expect(dialog().textContent).toContain('ทดสอบ');
    typeName('ทดสอ');
    expect(confirmButton().disabled).toBe(true);
    typeName(' ทดสอบ ');
    expect(confirmButton().disabled).toBe(false);

    const reason = within(dialog()).getByLabelText('เหตุผล (ไม่บังคับ)') as HTMLTextAreaElement;
    expect(within(dialog()).getByText('0/200')).toBeTruthy();
    fireEvent.change(reason, { target: { value: 'ก'.repeat(200) } });
    expect(within(dialog()).getByText('200/200')).toBeTruthy();
    fireEvent.change(reason, { target: { value: 'ก'.repeat(201) } });
    expect([...reason.value]).toHaveLength(200);
    expect(within(dialog()).getByText('200/200')).toBeTruthy();
  });

  it('says what happens: a played game keeps its summary, a lobby / setup game has none', async () => {
    server();
    openTab();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'ปิดเกม ทดสอบ' }));
    expect(dialog().textContent).toContain('ยังดูหน้าสรุปได้');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'ยกเลิก' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ปิดเกม เตรียมตัว' }));
    expect(dialog().textContent).toContain('ไม่มีหน้าสรุป');
  });
});

describe('C3 sending the close', () => {
  it('one request however often it is pressed, the button off while waiting; success marks the row closed', async () => {
    let answer!: (r: Response) => void;
    const calls = server({ close: () => new Promise<Response>((resolve) => (answer = resolve)) });
    openTab();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'ปิดเกม ทดสอบ' }));
    typeName('ทดสอบ');
    fireEvent.change(within(dialog()).getByLabelText('เหตุผล (ไม่บังคับ)'), { target: { value: 'ทดสอบระบบ' } });
    const confirm = confirmButton();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(closes(calls)).toHaveLength(1));
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().getAttribute('aria-busy')).toBe('true');
    expect(closes(calls)[0]).toEqual({ method: 'POST', path: '/api/admin/games/g-play/close', body: { confirmName: 'ทดสอบ', reason: 'ทดสอบระบบ' } });

    await act(async () => answer(Response.json(row({ phase: 'ended', endedReason: 'closed' }))));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(rowOf('ทดสอบ').textContent).toContain('ปิดโดยผู้ดูแล');
    expect(screen.queryByRole('button', { name: 'ปิดเกม ทดสอบ' })).toBeNull();
    expect(closes(calls)).toHaveLength(1);
  });

  it('an error keeps the dialog open with the message inside it', async () => {
    server({ close: () => Response.json({ code: 'already_ended', message: 'เกมนี้จบหรือถูกปิดไปแล้ว' }, { status: 409 }) });
    openTab();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'ปิดเกม ทดสอบ' }));
    typeName('ทดสอบ');
    fireEvent.click(confirmButton());
    expect((await within(dialog()).findByRole('alert')).textContent).toContain('เกมนี้จบหรือถูกปิดไปแล้ว');
    expect(confirmButton().disabled).toBe(false);
  });

  it('401 goes back to the admin code page', async () => {
    server({ close: () => Response.json({ code: 'unauthorized', message: 'หน้านี้สำหรับเจ้าของ server เท่านั้น เข้าด้วย admin code ก่อน' }, { status: 401 }) });
    openTab();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'ปิดเกม ทดสอบ' }));
    typeName('ทดสอบ');
    fireEvent.click(confirmButton());
    expect(await screen.findByLabelText('admin code')).toBeTruthy();
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
  });

  it('401 on the list goes back to the admin code page too', async () => {
    server({ list: [() => Response.json({ code: 'unauthorized', message: 'เข้าด้วย admin code ก่อน' }, { status: 401 })] });
    openTab();
    expect(await screen.findByLabelText('admin code')).toBeTruthy();
  });
});

describe('C8 390 px and the gallery', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'library.css'), 'utf8');

  it('below the wide layout the table becomes cards (no sideways scroll) and its buttons are 44 x 44', () => {
    const narrow = [...css.matchAll(/@media[^{]*max-width[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].map((m) => m[1]!).join('\n');
    expect(narrow).toMatch(/\.agames[^{]*(?:tr|td)[^{]*\{[^}]*display:\s*(?:block|grid)/);
    expect(narrow).toMatch(/\.agames thead[^{]*\{[^}]*(?:display:\s*none|clip)/);
    expect(css).toMatch(/\.agames button[^{]*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px|\.agames button[^{]*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.close-dialog :is\(input, textarea\)[^{]*\{[^}]*min-height:\s*44px/);
    expect(css).not.toMatch(/\.agames[^{]*\{[^}]*overflow-x:\s*(?:scroll|auto)/);
  });

  it('every state of C1-C7 has a gallery scenario on its screen', () => {
    const want: [string, string][] = [
      ['admin-games', 'admin-games'],
      ['admin-games-loading', 'admin-games'],
      ['admin-games-error', 'admin-games'],
      ['admin-games-empty', 'admin-games'],
      ['admin-close-error', 'admin-games'],
      ['closed-play', 'play-lock'],
      ['closed-lobby', 'lobby'],
      ['closed-reopen', 'lobby'],
      ['ended-closed', 'ending'],
      ['ended-closed', 'home'],
    ];
    for (const [id, screenId] of want) {
      const s = scenarioById(id);
      expect(s.id).toBe(id);
      expect(s.screens).toContain(screenId);
    }
  });

  it('the gallery shows the 4-game list from the mock', async () => {
    const uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    try {
      render(<Gallery search="?screen=admin-games&scenario=admin-games" />);
      const t = await screen.findByRole('table', { name: 'รายการเกม' });
      expect(within(t).getAllByRole('row').slice(1).length).toBeGreaterThanOrEqual(4);
    } finally {
      uninstall();
    }
  });
});
