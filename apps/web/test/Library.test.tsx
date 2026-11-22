// GEN-091: the Learning library (Screens and Flows v2 §7, server owner only Q-168) on the GEN-099 fixtures.
// C4 empty / loading / error use the GEN-087 state components.
import type { LearningLibraryResponse } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminDashboard } from '../src/AdminDashboard.tsx';
import { LearningLibrary } from '../src/LearningLibrary.tsx';

const FULL = CONTRACT_FIXTURES.LearningLibraryResponse[0] as LearningLibraryResponse;
const EMPTY = CONTRACT_FIXTURES.LearningLibraryResponse[1] as LearningLibraryResponse;

type Reply = LearningLibraryResponse | 'down' | 'never' | 'forbidden';

function libraryServer(first: Reply) {
  const state: { reply: Reply } = { reply: first };
  const calls: { method: string; path: string; auth: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://api').pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, auth: new Headers(init?.headers).get('authorization') });
      if (path === '/api/admin/session') return Response.json({ token: 'adm-1', expiresAt: '2026-11-22T13:00:00.000Z' });
      if (path.startsWith('/api/admin/ai-usage')) return Response.json(CONTRACT_FIXTURES.AiUsageOverviewResponse[0]);
      if (state.reply === 'never') return new Promise<Response>(() => {});
      if (state.reply === 'down') throw new TypeError('Failed to fetch');
      if (state.reply === 'forbidden') return Response.json({ code: 'forbidden', message: 'หน้านี้สำหรับเจ้าของ server เท่านั้น' }, { status: 403 });
      if (method === 'DELETE' && path.startsWith('/api/admin/learning/games/')) return Response.json(EMPTY);
      if (method === 'DELETE') {
        const id = path.split('/').pop();
        const entries = FULL.entries.filter((e) => e.id !== id);
        return Response.json({ entries, counts: { ...FULL.counts, ruling: 0 } });
      }
      return Response.json(state.reply);
    }),
  );
  return { state, calls };
}

const onForbidden = vi.fn();
const open = () => render(<LearningLibrary apiBaseUrl="http://api" token="adm-1" onForbidden={onForbidden} />);

describe('GEN-091 Learning library', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    onForbidden.mockClear();
    sessionStorage.clear();
  });

  it('C4: loading is the skeleton, an empty library the empty state, a failure the error state with a retry', async () => {
    const { state } = libraryServer('never');
    open();
    expect(screen.getByRole('status', { name: 'กำลังโหลด…' }).className).toContain('skeleton');
    cleanup();

    state.reply = EMPTY;
    open();
    const empty = await screen.findByText('ยังไม่มีความรู้ใน library');
    expect(empty.closest('.state--empty')).toBeTruthy();
    expect(screen.getByText(/คะแนนเฉลี่ยเกิน 8/)).toBeTruthy();
    cleanup();

    state.reply = 'down';
    open();
    const error = await screen.findByRole('alert');
    expect(error.className).toContain('state--error');
    state.reply = FULL;
    fireEvent.click(within(error).getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(await screen.findByText('ผู้เล่นยื่นเหรียญให้ทหารยาม → โน้มน้าวสำเร็จ')).toBeTruthy();
  });

  it('lists the entries by source game with the type counts; a type chip narrows the list', async () => {
    const { calls } = libraryServer(FULL);
    open();
    const game = within(await screen.findByRole('region', { name: 'เกมต้นทาง คืนจันทราโลหิต' }));
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/admin/learning', auth: 'Bearer adm-1' });
    expect(game.getByText(/คะแนน 8\.6/)).toBeTruthy();
    expect(game.getAllByRole('article')).toHaveLength(4);

    const types = within(screen.getByRole('group', { name: 'ชนิดความรู้' }));
    expect(types.getAllByRole('button').map((b) => b.textContent)).toEqual(['ทั้งหมด 4', 'ตำนานโลก 1', 'ข้อเสนอจากผู้เล่น 1', 'การตัดสินที่ดี 1', 'สไตล์ผู้เล่น 1']);
    fireEvent.click(types.getByRole('button', { name: /การตัดสินที่ดี/ }));
    expect(game.getAllByRole('article')).toHaveLength(1);
    // a ruling shows its roll (an admin page: numbers are fine)
    const ruling = game.getByRole('article');
    expect(ruling.textContent).toContain('d20 12');
    expect(ruling.textContent).toContain('ปานกลาง');
    expect(ruling.textContent).toContain('👍 3/4');
    expect(ruling.textContent).toContain('persuade');
  });

  it('Q-223: an entry of a game that dropped to 8 or lower is shown as suspended', async () => {
    libraryServer(FULL);
    open();
    const style = (await screen.findByText('ชอบสังเกตก่อนลงมือ')).closest('article')!;
    expect(within(style).getByText(/^พักไว้/)).toBeTruthy();
    const ruling = screen.getByText('ผู้เล่นยื่นเหรียญให้ทหารยาม → โน้มน้าวสำเร็จ').closest('article')!;
    expect(within(ruling).queryByText(/^พักไว้/)).toBeNull();
  });

  it('deleting one entry asks first, then deletes and shows what the server has left', async () => {
    const { calls } = libraryServer(FULL);
    open();
    const ruling = (await screen.findByText('ผู้เล่นยื่นเหรียญให้ทหารยาม → โน้มน้าวสำเร็จ')).closest('article')!;
    fireEvent.click(within(ruling).getByRole('button', { name: 'ลบ' }));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/AI GM จะไม่ใช้ความรู้นี้อีก กู้คืนไม่ได้/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'ยกเลิก' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    fireEvent.click(within(ruling).getByRole('button', { name: 'ลบ' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ลบ' }));
    await waitFor(() => expect(screen.queryByText('ผู้เล่นยื่นเหรียญให้ทหารยาม → โน้มน้าวสำเร็จ')).toBeNull());
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/admin/learning/le-1', auth: 'Bearer adm-1' });
    expect(screen.getByText('ชอบสังเกตก่อนลงมือ')).toBeTruthy();
  });

  it('deleting a whole game asks first and names the game', async () => {
    const { calls } = libraryServer(FULL);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'ลบทั้งเกมนี้' }));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/คืนจันทราโลหิต/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'ลบทั้งเกม' }));
    expect(await screen.findByText('ยังไม่มีความรู้ใน library')).toBeTruthy();
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/admin/learning/games/g-old', auth: 'Bearer adm-1' });
  });

  it('Q-168: a 403 hands the message back (the owner signs in again); nothing is shown', async () => {
    libraryServer('forbidden');
    open();
    await waitFor(() => expect(onForbidden).toHaveBeenCalledWith('หน้านี้สำหรับเจ้าของ server เท่านั้น'));
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('Q-168: the library is behind the admin code, as a tab next to the AI usage', async () => {
    libraryServer(FULL);
    render(<AdminDashboard apiBaseUrl="" />);
    expect(screen.queryByRole('button', { name: 'Learning library' })).toBeNull();
    fireEvent.change(screen.getByLabelText('admin code'), { target: { value: 'รหัส' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้า dashboard' }));
    await screen.findByRole('heading', { name: 'การใช้ AI ทุกเกม' });
    fireEvent.click(screen.getByRole('button', { name: 'Learning library' }));
    expect(await screen.findByRole('region', { name: 'เกมต้นทาง คืนจันทราโลหิต' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'การใช้ AI ทุกเกม' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'การใช้ AI' }));
    expect(await screen.findByRole('heading', { name: 'การใช้ AI ทุกเกม' })).toBeTruthy();
  });
});
