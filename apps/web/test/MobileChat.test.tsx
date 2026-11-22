// GEN-123: the Play page on a phone (< 768): which layout, the info sheet and the device back button, the action bar's icons, the CSS rules.
import { RoomState } from '@isekai/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionBar, EMPTY_DRAFT } from '../src/play/chat/ActionBar.tsx';
import { MobileLayout } from '../src/play/chat/MobileLayout.tsx';
import { COMPACT_QUERY, useCompact } from '../src/play/chat/useCompact.ts';
import { useInfoSheet } from '../src/play/chat/useInfoSheet.ts';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';

const here = dirname(fileURLToPath(import.meta.url));
const css = (file: string) => readFileSync(join(here, '..', 'src', 'play', file), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (source: string, selector: string) => new RegExp(`(?:^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';

/** A matchMedia that the test can flip, like a window that is resized. */
function fakeMedia(width: number) {
  const listeners = new Set<() => void>();
  const state = { width };
  const matches = () => state.width < 768;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === COMPACT_QUERY && matches();
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return (next: number) => {
    state.width = next;
    act(() => listeners.forEach((fn) => fn()));
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '');
});

describe('C6 one rule: phone layout under 768, desktop frame from 768 up', () => {
  it('the query is max-width 767.98px (so 768 is desktop) and follows the window', () => {
    expect(COMPACT_QUERY).toBe('(max-width: 767.98px)');
    const resize = fakeMedia(390);
    const { result } = renderHook(() => useCompact());
    expect(result.current).toBe(true);
    resize(768);
    expect(result.current).toBe(false);
    resize(767);
    expect(result.current).toBe(true);
  });

  it('a browser without matchMedia gets the desktop frame', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useCompact()).result.current).toBe(false);
  });
});

describe('C3 the info sheet and the device back button', () => {
  it('open pushes one history entry; the back button closes; the close button pops it again', async () => {
    const { result } = renderHook(() => useInfoSheet());
    const before = window.history.length;
    act(() => result.current.show('self'));
    expect(result.current.tab).toBe('self');
    expect(window.history.length).toBe(before + 1);

    act(() => window.history.back());
    await waitFor(() => expect(result.current.tab).toBeNull());

    act(() => result.current.show('bag'));
    expect(result.current.tab).toBe('bag');
    act(() => result.current.close());
    await waitFor(() => expect(result.current.tab).toBeNull());
    expect(window.history.state?.v3Sheet).toBeFalsy();
  });

  it('changing tab inside the sheet adds no entry', () => {
    const { result } = renderHook(() => useInfoSheet());
    act(() => result.current.show('self'));
    const length = window.history.length;
    act(() => result.current.show('people'));
    expect(result.current.tab).toBe('people');
    expect(window.history.length).toBe(length);
  });

  it('closing with no entry of ours on top (a reload) still closes', () => {
    const { result } = renderHook(() => useInfoSheet());
    act(() => result.current.show('self'));
    window.history.replaceState(null, '');
    act(() => result.current.close());
    expect(result.current.tab).toBeNull();
  });
});

const room = RoomState.parse(CONTRACT_FIXTURES.RoomState[0]);
const baseBar = { room, seenBy: 3, draft: EMPTY_DRAFT, setDraft: () => {}, problem: undefined, sending: false, onSend: () => {}, onRetry: () => {} };

describe('C2 action bar on a phone', () => {
  it('eight icon buttons with only an aria-label, and อื่นๆ that lists all eight with words', () => {
    render(<ActionBar {...baseBar} compact />);
    const row = screen.getByRole('group', { name: 'แถบ action' });
    const icons = within(row).getAllByRole('button');
    // 8 words + the อื่นๆ button
    expect(icons).toHaveLength(9);
    for (const word of ['พูดคุย', 'สังเกต', 'สืบค้น', 'โจมตี', 'ป้องกัน', 'สวด', 'ลอบเร้น', 'พัก']) {
      const btn = within(row).getByRole('button', { name: word });
      expect(btn.getAttribute('aria-label')).toBe(word);
      expect(btn.textContent).toBe('');
    }
    const more = screen.getByRole('button', { name: 'อื่นๆ' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'การกระทำทั้งหมด' })).toBeNull();

    fireEvent.click(more);
    const list = screen.getByRole('group', { name: 'การกระทำทั้งหมด' });
    for (const word of ['พูดคุย', 'สังเกต', 'สืบค้น', 'โจมตี', 'ป้องกัน', 'สวด', 'ลอบเร้น', 'พัก']) expect(within(list).getByRole('button', { name: word }).textContent).toContain(word);
  });

  it('a word in the list prefills the box and closes the list', () => {
    const setDraft = vi.fn();
    render(<ActionBar {...baseBar} setDraft={setDraft} compact />);
    fireEvent.click(screen.getByRole('button', { name: 'อื่นๆ' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'การกระทำทั้งหมด' })).getByRole('button', { name: 'สืบค้น' }));
    expect(setDraft).toHaveBeenCalledWith(expect.objectContaining({ text: 'สืบค้น' }));
    expect(screen.queryByRole('group', { name: 'การกระทำทั้งหมด' })).toBeNull();
    expect(screen.getByRole('button', { name: 'อื่นๆ' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('the desktop bar is unchanged: words on the buttons, no อื่นๆ', () => {
    render(<ActionBar {...baseBar} />);
    expect(screen.queryByRole('button', { name: 'อื่นๆ' })).toBeNull();
    expect(screen.getByRole('button', { name: 'สังเกต' }).textContent).toContain('สังเกต');
  });
});

describe('C3 MobileLayout: bottom tabs open a sheet', () => {
  function layout() {
    return render(<MobileLayout hud={<div>HUD</div>} feed={<p>feed</p>} actions={<form aria-label="bar" />} panel={(tab) => <p>panel {tab}</p>} />);
  }

  it('ตัวฉัน opens the sheet with that panel; ปิด and the back button close it', async () => {
    layout();
    const nav = screen.getByRole('navigation', { name: 'แผงข้อมูล' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['ฉาก', 'ตัวฉัน', 'กระเป๋า', 'คนรอบตัว']);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(within(nav).getByRole('button', { name: 'ตัวฉัน' }));
    const sheet = screen.getByRole('dialog', { name: 'แผงข้อมูล' });
    expect(within(sheet).getByText('panel self')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'ปิด' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(nav).getByRole('button', { name: 'กระเป๋า' }));
    expect(screen.getByText('panel bag')).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the sheet has its own four tabs to move between panels', () => {
    layout();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'แผงข้อมูล' })).getByRole('button', { name: 'ฉาก' }));
    const sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('tab', { name: 'คนรอบตัว' }));
    expect(within(sheet).getByText('panel people')).toBeTruthy();
  });
});

describe('C1 / C4 / C5 the phone CSS (measured in Chrome too; jsdom has no layout)', () => {
  const chat = css('chat/chat.css');
  const phone = chat.slice(chat.indexOf('@container play (max-width: 767.98px)'));

  it('there is one phone block under 768 and the desktop block is not the old stack-only one', () => {
    expect(chat).toContain('@container play (max-width: 767.98px)');
    expect(chat).not.toContain('max-width: 959.98px');
  });

  it('bubbles are at most 78% wide', () => {
    expect(rule(phone, '.chat-col')).toMatch(/max-width:\s*78%/);
  });

  it('the frame follows the visible viewport and keeps clear of the home bar; nothing is fixed', () => {
    const frame = rule(chat, '.v3m');
    expect(frame).toMatch(/height:\s*100%/);
    expect(chat).toMatch(/env\(safe-area-inset-bottom/);
    expect(chat).not.toMatch(/position:\s*fixed/);
    expect(chat).toMatch(/overflow-x:\s*hidden/);
  });

  it('every phone button is at least 44 x 44; the icon buttons are exactly that', () => {
    expect(rule(chat, '.play .chat-quick__btn--icon')).toMatch(/width:\s*44px/);
    expect(rule(chat, '.play .chat-quick__btn--icon')).toMatch(/height:\s*44px/);
    expect(rule(chat, '.play .v3m-nav__btn')).toMatch(/min-height:\s*48px/);
    expect(rule(chat, '.play .v3m-sheet__close')).toMatch(/min-height:\s*44px/);
  });

  it('colours come from tokens only', () => {
    expect(chat).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(chat).not.toMatch(/rgba?\(/);
  });
});
