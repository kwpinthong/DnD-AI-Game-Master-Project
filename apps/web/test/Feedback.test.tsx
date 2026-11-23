// ISK-011: Report & Feedback on the web. The player's box (every in-game page, POST /api/feedback of ISK-010)
// and the owner's ฟีดแบ็ก tab in /admin (GET / PATCH /api/admin/feedback).
import type { FeedbackRow } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminDashboard } from '../src/AdminDashboard.tsx';
import { CharacterScreen } from '../src/CharacterScreen.tsx';
import { Gallery } from '../src/dev/Gallery.tsx';
import { SCREEN_VIEWS } from '../src/dev/screens.tsx';
import { FeedbackAdmin } from '../src/FeedbackAdmin.tsx';
import { GameSummaryPage } from '../src/GameHistory.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { installMock, MOCK_TOKEN, mockBaseUrl } from '../src/mock/install.ts';
import { SCENARIOS } from '../src/mock/scenarios.ts';
import { OriginCard } from '../src/OriginCard.tsx';
import { COMPACT_QUERY } from '../src/play/chat/useCompact.ts';
import { PlayRoom } from '../src/PlayRoom.tsx';
import { FeedbackButton } from '../src/ui/FeedbackDialog.tsx';

const LABEL = 'รายงาน / ข้อเสนอ';
const THANKS = /ขอบคุณ ได้รับแล้ว/;
const noop = () => {};
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'ui', 'feedback.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

const dialog = () => screen.getByRole('dialog', { name: LABEL });
const box = () => within(dialog()).getByRole('textbox', { name: /ข้อความ/ }) as HTMLTextAreaElement;
const sendButton = () => within(dialog()).getByRole('button', { name: 'ส่ง' }) as HTMLButtonElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const codePoints = (s: string) => [...s].length;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

// ---------------------------------------------------------------------------------------------------------------
// The box itself, against a stubbed server.

type Reply = 'ok' | '429' | '401' | '500' | 'down' | 'never';

function feedbackServer(first: Reply) {
  const state = { reply: first };
  const sent: { auth: string | null; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      switch (state.reply) {
        case 'never':
          return new Promise<Response>(() => {});
        case 'down':
          throw new TypeError('Failed to fetch');
        case '429':
          return Response.json({ code: 'rate_limited', message: 'ส่งได้ 5 ครั้งใน 10 นาที ลองใหม่อีกสักครู่' }, { status: 429 });
        case '401':
          return Response.json({ code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' }, { status: 401 });
        case '500':
          return Response.json({ code: 'internal', message: 'server ขัดข้อง' }, { status: 500 });
        default:
          return Response.json(CONTRACT_FIXTURES.FeedbackRow[0], { status: 201 });
      }
    }),
  );
  return { state, sent };
}

function openBox(page: 'lobby' | 'play' = 'lobby') {
  render(<FeedbackButton apiBaseUrl="http://api" token="tok-1" page={page} />);
  fireEvent.click(screen.getByRole('button', { name: LABEL }));
}

describe('ISK-011 the report box', () => {
  it('C2: 1000 code points is the most; the counter says 1000/1000 and more cannot be typed', () => {
    openBox();
    type('ก'.repeat(1000));
    expect(within(dialog()).getByText('1000/1000')).toBeTruthy();
    type('ก'.repeat(1001));
    expect(codePoints(box().value)).toBe(1000);
    expect(within(dialog()).getByText('1000/1000')).toBeTruthy();
  });

  it('C3: sent → "ขอบคุณ ได้รับแล้ว", the box closes; the body has type / text / page and the session token', async () => {
    const { sent } = feedbackServer('ok');
    openBox('play');
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'ข้อเสนอ' }));
    type('  อยากให้มีแผนที่  ');
    fireEvent.click(sendButton());
    expect(await screen.findByText(THANKS)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.auth).toBe('Bearer tok-1');
    expect(sent[0]!.body).toMatchObject({ type: 'idea', text: '  อยากให้มีแผนที่  ', page: 'play' });
    // a sent text is gone: the next box starts empty again
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    expect(box().value).toBe('');
    expect((within(dialog()).getByRole('radio', { name: 'บั๊ก' }) as HTMLInputElement).checked).toBe(true);
  });

  it('C4: 429 → "ส่งบ่อยเกินไป…", the text stays; a second press while sending sends once', async () => {
    const { state, sent } = feedbackServer('429');
    openBox();
    type('ปุ่มส่งค้าง');
    fireEvent.click(sendButton());
    expect(await within(dialog()).findByText('ส่งบ่อยเกินไป ลองอีกครั้งในอีกสักครู่')).toBeTruthy();
    expect(box().value).toBe('ปุ่มส่งค้าง');

    state.reply = 'never';
    sent.length = 0;
    fireEvent.click(sendButton());
    fireEvent.click(sendButton());
    fireEvent.submit(box().closest('form')!);
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    expect(sent).toHaveLength(1);
  });

  it('C7: the text is shown as letters, never run as HTML (player box)', () => {
    openBox();
    type('<script>window.hacked = 1</script>');
    expect(box().value).toBe('<script>window.hacked = 1</script>');
    expect(document.querySelector('script')).toBeNull();
  });

  it('C8: 1000 code points of Thai with tone marks is 1000/1000 and can be sent; only spaces cannot', async () => {
    const { sent } = feedbackServer('ok');
    openBox();
    const thai = 'ก่'.repeat(500); // 2 code points each
    type(thai);
    expect(within(dialog()).getByText('1000/1000')).toBeTruthy();
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    expect(await screen.findByText(THANKS)).toBeTruthy();
    expect(codePoints(String(sent[0]!.body.text))).toBe(1000);

    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    type('   \n\t ');
    expect(sendButton().disabled).toBe(true);
  });

  it('C9: 500 or no network → a message and the text stays; 401 → join the game again; closing keeps the draft', async () => {
    const { state } = feedbackServer('500');
    openBox();
    type('หน้าค้าง');
    fireEvent.click(sendButton());
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(box().value).toBe('หน้าค้าง');

    state.reply = 'down';
    fireEvent.click(sendButton());
    expect(await within(dialog()).findByText(/ติดต่อ server ไม่ได้/)).toBeTruthy();
    expect(box().value).toBe('หน้าค้าง');

    state.reply = '401';
    fireEvent.click(sendButton());
    expect(await within(dialog()).findByText(/เข้าเกมใหม่/)).toBeTruthy();
    expect(box().value).toBe('หน้าค้าง');

    // closed without sending: the draft (and the type) is still there when the box opens again
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'อื่นๆ' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'ปิด' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    expect(box().value).toBe('หน้าค้าง');
    expect((within(dialog()).getByRole('radio', { name: 'อื่นๆ' }) as HTMLInputElement).checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The box on the real pages, on the mock server (the mock checks the body against FeedbackInput).

describe('ISK-011 the box on every in-game page', () => {
  let uninstall: () => void;
  let cell = 0;
  beforeEach(() => {
    localStorage.clear();
    uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    uninstall();
  });

  /** Records what reaches POST /api/feedback on the way to the mock. */
  function recordFeedback() {
    const inner = globalThis.fetch;
    const pages: unknown[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/feedback') && init?.method === 'POST') pages.push((JSON.parse(String(init.body)) as { page: unknown }).page);
      return inner(input, init);
    });
    return pages;
  }

  const base = (scenario: string) => mockBaseUrl(scenario, `fb${++cell}`);

  async function sendFrom(open: () => Promise<void>) {
    await open();
    type('ทดสอบ');
    fireEvent.click(sendButton());
    expect(await screen.findByText(THANKS)).toBeTruthy();
  }

  const corner = async () => {
    fireEvent.click(await screen.findByRole('button', { name: LABEL }));
  };

  async function viaPlayMenu() {
    await screen.findByText('เชื่อมต่อแล้ว');
    fireEvent.click(screen.getAllByRole('button', { name: 'เมนู' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: LABEL }));
  }

  function playRoom(scenario = 'normal') {
    render(<PlayRoom apiBaseUrl={base(scenario)} token={MOCK_TOKEN} onBack={noop} onGameList={noop} onNeedCharacter={noop} onSessionLost={noop} />);
  }

  it('C1: Play → เมนู → รายงาน / ข้อเสนอ opens the box: type บั๊ก, send disabled', async () => {
    playRoom();
    await viaPlayMenu();
    expect((within(dialog()).getByRole('radio', { name: 'บั๊ก' }) as HTMLInputElement).checked).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(within(dialog()).getByText('0/1000')).toBeTruthy();
  });

  it('C3: from Play the body says page = play', async () => {
    const pages = recordFeedback();
    playRoom();
    await sendFrom(viaPlayMenu);
    expect(pages).toEqual(['play']);
  });

  it('C5: the phone Play has it in its menu too', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === COMPACT_QUERY, addEventListener: noop, removeEventListener: noop }));
    const pages = recordFeedback();
    playRoom();
    await sendFrom(viaPlayMenu);
    expect(pages).toEqual(['play']);
  });

  const pageCases: [string, string, () => ReactNode][] = [
    ['lobby', 'lobby', () => <Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} />],
    ['character', 'character', () => <CharacterScreen apiBaseUrl={base('no-character')} token={MOCK_TOKEN} onBack={noop} onSessionLost={noop} />],
    ['loot', 'loot', () => <CharacterScreen apiBaseUrl={base('loot-loading')} token={MOCK_TOKEN} onBack={noop} onSessionLost={noop} />],
    ['spawn (origin card)', 'spawn', () => <OriginCard apiBaseUrl={base('normal')} token={MOCK_TOKEN} onClose={noop} />],
    ['ending', 'ending', () => <GameSummaryPage apiBaseUrl={base('ended')} token={MOCK_TOKEN} onBack={noop} />],
  ];

  it.each(pageCases)('C5: %s has the corner button (≥ 44px, labelled) and sends its page', async (_name, page, ui) => {
    const pages = recordFeedback();
    render(<>{ui()}</>);
    const button = await screen.findByRole('button', { name: LABEL });
    expect(button.className).toContain('feedback-corner');
    await sendFrom(corner);
    expect(pages).toEqual([page]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The owner's tab.

const ROW = CONTRACT_FIXTURES.FeedbackRow[0] as FeedbackRow;
const LONG = `${'ข้อความยาวมาก '.repeat(20)}ท้ายสุด`;
const ROWS: FeedbackRow[] = [
  { ...ROW, id: 1, type: 'bug', text: 'ปุ่มส่งค้าง', status: 'new' },
  { ...ROW, id: 2, type: 'idea', text: LONG, status: 'reviewing', context: { ...ROW.context, day: null, period: null, turn: null, page: 'lobby' } },
  { ...ROW, id: 3, type: 'other', text: '<script>window.hacked = 1</script>', status: 'done' },
];

type AdminReply = 'rows' | 'empty' | 'never' | 'down';

function adminServer(first: AdminReply) {
  const state: { reply: AdminReply; patch: 'ok' | 'fail' } = { reply: first, patch: 'ok' };
  const patches: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://api').pathname;
      if (path === '/api/admin/session') return Response.json({ token: 'adm-1', expiresAt: '2026-11-22T13:00:00.000Z' });
      if (path.startsWith('/api/admin/ai-usage')) return Response.json(CONTRACT_FIXTURES.AiUsageOverviewResponse[0]);
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { status: FeedbackRow['status'] };
        patches.push({ path, body });
        if (state.patch === 'fail') return Response.json({ code: 'internal', message: 'บันทึกไม่ได้' }, { status: 500 });
        const id = Number(path.split('/').pop());
        return Response.json({ ...ROWS.find((r) => r.id === id)!, status: body.status });
      }
      if (state.reply === 'never') return new Promise<Response>(() => {});
      if (state.reply === 'down') throw new TypeError('Failed to fetch');
      return Response.json({ feedback: state.reply === 'empty' ? [] : ROWS });
    }),
  );
  return { state, patches };
}

const table = () => screen.getByRole('table', { name: 'รายงานจากผู้เล่น' });
const bodyRows = () => within(table()).getAllByRole('row').slice(1);
const statusOf = (id: number) => screen.getByRole('combobox', { name: `สถานะของ #${id}` }) as HTMLSelectElement;
const openTab = () => render(<FeedbackAdmin apiBaseUrl="http://api" token="adm-1" onForbidden={noop} />);

describe('ISK-011 the ฟีดแบ็ก tab in /admin', () => {
  it('C6: the tab lists the 3 rows; filter status new → only new; set a row to เสร็จ → the row updates', async () => {
    const { patches } = adminServer('rows');
    render(<AdminDashboard apiBaseUrl="" />);
    fireEvent.change(screen.getByLabelText('admin code'), { target: { value: 'รหัส' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้า dashboard' }));
    await screen.findByRole('heading', { name: 'การใช้ AI ทุกเกม' });
    fireEvent.click(screen.getByRole('button', { name: 'ฟีดแบ็ก' }));

    await screen.findByRole('table', { name: 'รายงานจากผู้เล่น' });
    expect(bodyRows()).toHaveLength(3);
    for (const header of ['วันที่', 'ประเภท', 'เกม', 'วัน-ช่วง', 'ข้อความ', 'สถานะ']) expect(within(table()).getByRole('columnheader', { name: header })).toBeTruthy();
    expect(within(bodyRows()[0]!).getByText('บั๊ก')).toBeTruthy();
    expect(within(bodyRows()[0]!).getByText(/วัน 3/)).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'กรองสถานะ' }), { target: { value: 'new' } });
    expect(bodyRows()).toHaveLength(1);
    expect(statusOf(1).value).toBe('new');

    fireEvent.change(statusOf(1), { target: { value: 'done' } });
    await waitFor(() => expect(patches).toEqual([{ path: '/api/admin/feedback/1', body: { status: 'done' } }]));
    fireEvent.change(screen.getByRole('combobox', { name: 'กรองสถานะ' }), { target: { value: '' } });
    await waitFor(() => expect(statusOf(1).value).toBe('done'));
    expect([...statusOf(1).options].map((o) => o.text)).toEqual(['ใหม่', 'กำลังดู', 'เสร็จ']);
  });

  it('C6: loading, empty and error each show their state', async () => {
    const { state } = adminServer('never');
    openTab();
    expect(screen.getByRole('status', { name: /กำลังโหลด/ }).className).toContain('skeleton');
    cleanup();

    state.reply = 'empty';
    openTab();
    expect((await screen.findByText('ยังไม่มีรายงาน')).closest('.state--empty')).toBeTruthy();
    cleanup();

    state.reply = 'down';
    openTab();
    const error = await screen.findByRole('alert');
    expect(error.className).toContain('state--error');
    state.reply = 'rows';
    fireEvent.click(within(error).getByRole('button', { name: 'ลองอีกครั้ง' }));
    await screen.findByRole('table', { name: 'รายงานจากผู้เล่น' });
    expect(bodyRows()).toHaveLength(3);
  });

  it('C7: a <script> text is shown as letters in the table, never run', async () => {
    adminServer('rows');
    openTab();
    await screen.findByRole('table', { name: 'รายงานจากผู้เล่น' });
    expect(screen.getByText('<script>window.hacked = 1</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect((window as { hacked?: number }).hacked).toBeUndefined();
  });

  it('C10: filter type idea → only idea; a failed status change goes back + says so; a row opens its full text', async () => {
    const { state } = adminServer('rows');
    openTab();
    await screen.findByRole('table', { name: 'รายงานจากผู้เล่น' });

    fireEvent.change(screen.getByRole('combobox', { name: 'กรองประเภท' }), { target: { value: 'idea' } });
    expect(bodyRows()).toHaveLength(1);
    expect(within(bodyRows()[0]!).getByText('ข้อเสนอ')).toBeTruthy();

    // the long text is cut short until the row is opened
    expect(screen.queryByText(LONG)).toBeNull();
    fireEvent.click(within(bodyRows()[0]!).getByRole('button', { name: /ข้อความยาวมาก/ }));
    expect(screen.getByText(LONG)).toBeTruthy();

    state.patch = 'fail';
    fireEvent.change(statusOf(2), { target: { value: 'done' } });
    expect(await screen.findByText(/เปลี่ยนสถานะไม่สำเร็จ/)).toBeTruthy();
    expect(statusOf(2).value).toBe('reviewing');
    expect(statusOf(2).closest('.feedback-admin')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C11: the phone and the gallery.

/** The declarations of the first rule whose selector list has `selector`. */
function rule(selector: string, source = css): string {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1]!.split(',').map((s) => s.trim()).includes(selector)) return m[2]!;
  return '';
}

describe('ISK-011 C11 the phone and the gallery', () => {
  it('at 390 px the box fills the screen without overflow; every button is ≥ 44 x 44 and labelled', () => {
    const phone = /@media \(max-width: 767\.98px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(rule('.feedback-dialog', phone)).toMatch(/width:\s*100%/);
    expect(rule('.feedback-dialog', phone)).toMatch(/height:\s*100%/);
    expect(rule('.feedback-dialog')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.feedback-dialog')).toMatch(/box-sizing:\s*border-box/);
    // two classes: .btn (min-height 36px) and .dialog-backdrop load in any order and must not win
    expect(rule('.btn.feedback-corner')).toMatch(/min-width:\s*44px/);
    expect(rule('.btn.feedback-corner')).toMatch(/min-height:\s*44px/);
    expect(rule('.dialog-backdrop.feedback-backdrop', phone)).toMatch(/padding:\s*0/);
    expect(rule('.feedback-dialog .btn')).toMatch(/min-height:\s*44px/);
    expect(rule('.feedback-type label')).toMatch(/min-height:\s*44px/);
    expect(rule('.feedback-thanks .btn')).toMatch(/min-height:\s*44px/);
    expect(rule('.feedback-admin select')).toMatch(/min-height:\s*44px/);
    expect(rule('.feedback-admin button')).toMatch(/min-height:\s*44px/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);

    openBox();
    for (const button of screen.getAllByRole('button')) expect(button.textContent?.trim() || button.getAttribute('aria-label')).toBeTruthy();
  });

  it('the gallery has the box in every state and the admin tab', async () => {
    expect(SCREEN_VIEWS.feedback?.render).toBeTruthy();
    expect(SCREEN_VIEWS['admin-feedback']?.render).toBeTruthy();
    const states = SCENARIOS.filter((s) => (s.screens as readonly string[]).includes('feedback')).map((s) => s.id);
    expect(states).toEqual(expect.arrayContaining(['normal', 'feedback-sending', 'feedback-rate-limited', 'feedback-session-lost', 'feedback-error']));
    const tabs = SCENARIOS.filter((s) => (s.screens as readonly string[]).includes('admin-feedback')).map((s) => s.id);
    expect(tabs).toEqual(expect.arrayContaining(['normal', 'feedback-empty', 'feedback-loading', 'feedback-list-error']));

    localStorage.clear();
    const uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
    try {
      render(<Gallery search="?screen=feedback&scenario=feedback-rate-limited" />);
      const frame = screen.getByRole('figure', { name: 'feedback · feedback-rate-limited' });
      const send = within(frame).getByRole('button', { name: 'ส่ง' });
      await act(async () => fireEvent.click(send));
      expect(await within(frame).findByText('ส่งบ่อยเกินไป ลองอีกครั้งในอีกสักครู่')).toBeTruthy();
    } finally {
      cleanup();
      uninstall();
    }
  });
});
