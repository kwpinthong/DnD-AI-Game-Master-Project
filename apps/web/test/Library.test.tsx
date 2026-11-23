// GEN-091 / GEN-084: the Learning library (Screens and Flows v2 §7, server owner only Q-168) on the contract fixtures.
// Loading / empty / error use the GEN-087 state components.
import type { LearningLibraryResponse } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminDashboard } from '../src/AdminDashboard.tsx';
import { LearningLibrary } from '../src/LearningLibrary.tsx';

const FULL = CONTRACT_FIXTURES.LearningLibraryResponse[0] as LearningLibraryResponse;
const EMPTY = CONTRACT_FIXTURES.LearningLibraryResponse[1] as LearningLibraryResponse;
const NPC_LIB = CONTRACT_FIXTURES.NpcLibraryResponse[0]!;
const GOOD_TEXT = 'ผู้เล่นยื่นเหรียญให้ทหารยาม → ปานกลาง สำเร็จ';

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
      if (path.startsWith('/api/admin/npc-library')) return Response.json(NPC_LIB);
      if (state.reply === 'never') return new Promise<Response>(() => {});
      if (state.reply === 'down') throw new TypeError('Failed to fetch');
      if (state.reply === 'forbidden') return Response.json({ code: 'forbidden', message: 'หน้านี้สำหรับเจ้าของ server เท่านั้น' }, { status: 403 });
      if (method === 'DELETE' && path.startsWith('/api/admin/learning/games/')) return Response.json(EMPTY);
      if (method === 'DELETE') {
        const id = path.split('/').pop();
        const entries = FULL.entries.filter((e) => e.id !== id);
        return Response.json({ entries, counts: { ...FULL.counts, good_example: 0 } });
      }
      return Response.json(state.reply);
    }),
  );
  return { state, calls };
}

const onForbidden = vi.fn();
const open = () => render(<LearningLibrary apiBaseUrl="http://api" token="adm-1" onForbidden={onForbidden} />);

async function signIn() {
  render(<AdminDashboard apiBaseUrl="" />);
  fireEvent.change(screen.getByLabelText('admin code'), { target: { value: 'รหัส' } });
  fireEvent.click(screen.getByRole('button', { name: 'เข้า dashboard' }));
  await screen.findByRole('heading', { name: 'การใช้ AI ทุกเกม' });
  fireEvent.click(screen.getByRole('button', { name: 'Learning library' }));
}

describe('GEN-084 Learning library', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    onForbidden.mockClear();
    sessionStorage.clear();
  });

  it('C2 / C5: loading is the skeleton, an empty library the empty state, a failure the error state with a retry', async () => {
    const { state } = libraryServer('never');
    open();
    expect(screen.getByRole('status', { name: 'กำลังโหลด…' }).className).toContain('skeleton');
    cleanup();

    state.reply = EMPTY;
    open();
    const empty = await screen.findByText('ยังไม่มีความรู้ใน library');
    expect(empty.closest('.state--empty')).toBeTruthy();
    expect(screen.getByText(/เกมจบ/)).toBeTruthy();
    cleanup();

    state.reply = 'down';
    open();
    const error = await screen.findByRole('alert');
    expect(error.className).toContain('state--error');
    state.reply = FULL;
    fireEvent.click(within(error).getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(await screen.findByText(GOOD_TEXT)).toBeTruthy();
  });

  it('C1: the entries by source game (name + date) in 5 types; good / avoid show 👍 / 👎 / players; a type chip narrows the list', async () => {
    const { calls } = libraryServer(FULL);
    open();
    const game = within(await screen.findByRole('region', { name: 'เกมต้นทาง คืนจันทราโลหิต' }));
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/admin/learning', auth: 'Bearer adm-1' });
    expect(game.getByText(/คะแนน 8\.6/)).toBeTruthy();
    expect(game.getAllByRole('article')).toHaveLength(5);
    const date = new Date(FULL.entries[0]!.createdAt).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
    for (const article of game.getAllByRole('article')) expect(article.textContent).toContain(date);

    const types = within(screen.getByRole('group', { name: 'ชนิดความรู้' }));
    expect(types.getAllByRole('button').map((b) => b.textContent)).toEqual(['ทั้งหมด 5', 'ตำนานโลก 1', 'ข้อเสนอจากผู้เล่น 1', 'ตัวอย่างที่ดี 1', 'สิ่งที่ควรเลี่ยง 1', 'สไตล์ผู้เล่น 1']);
    fireEvent.click(types.getByRole('button', { name: /ตัวอย่างที่ดี/ }));
    expect(game.getAllByRole('article')).toHaveLength(1);
    // a ruling example shows its roll and the votes (an admin page: numbers are fine)
    const good = game.getByRole('article');
    for (const part of ['d20 12', 'ปานกลาง', '👍 3', '👎 0', 'ผู้เล่น 4', 'persuade']) expect(good.textContent).toContain(part);

    fireEvent.click(types.getByRole('button', { name: /สิ่งที่ควรเลี่ยง/ }));
    const avoid = game.getByRole('article');
    for (const part of ['👍 0', '👎 3', 'ผู้เล่น 4']) expect(avoid.textContent).toContain(part);
  });

  it('a suspended entry (its votes no longer pass) is marked as such', async () => {
    libraryServer(FULL);
    open();
    const style = (await screen.findByText('ชอบสังเกตก่อนลงมือ')).closest('article')!;
    expect(within(style).getByText(/^พักไว้/)).toBeTruthy();
    const good = screen.getByText(GOOD_TEXT).closest('article')!;
    expect(within(good).queryByText(/^พักไว้/)).toBeNull();
  });

  it('C3: deleting one entry asks first, then deletes and shows what the server has left', async () => {
    const { calls } = libraryServer(FULL);
    open();
    const good = (await screen.findByText(GOOD_TEXT)).closest('article')!;
    fireEvent.click(within(good).getByRole('button', { name: 'ลบ' }));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/AI GM จะไม่ใช้ความรู้นี้อีก กู้คืนไม่ได้/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'ยกเลิก' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    fireEvent.click(within(good).getByRole('button', { name: 'ลบ' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ลบ' }));
    await waitFor(() => expect(screen.queryByText(GOOD_TEXT)).toBeNull());
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/admin/learning/le-1', auth: 'Bearer adm-1' });
    expect(screen.getByText('ชอบสังเกตก่อนลงมือ')).toBeTruthy();
  });

  it('C6: deleting a whole game asks first and names the game; cancel deletes nothing', async () => {
    const { calls } = libraryServer(FULL);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'ลบทั้งเกมนี้' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'ยกเลิก' }));
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(screen.getByText(GOOD_TEXT)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ลบทั้งเกมนี้' }));
    const dialog = within(screen.getByRole('alertdialog'));
    expect(dialog.getByText(/คืนจันทราโลหิต/)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'ลบทั้งเกม' }));
    expect(await screen.findByText('ยังไม่มีความรู้ใน library')).toBeTruthy();
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/admin/learning/games/g-old', auth: 'Bearer adm-1' });
  });

  it('C4: a 403 hands the message back (the owner signs in again); nothing is shown', async () => {
    libraryServer('forbidden');
    open();
    await waitFor(() => expect(onForbidden).toHaveBeenCalledWith('หน้านี้สำหรับเจ้าของ server เท่านั้น'));
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ลบ' })).toBeNull();
  });

  it('C4: without the admin code /admin shows only the code form: no library, no delete button', () => {
    libraryServer(FULL);
    render(<AdminDashboard apiBaseUrl="" />);
    expect(screen.queryByRole('button', { name: 'Learning library' })).toBeNull();
    expect(screen.queryByRole('button', { name: /ลบ/ })).toBeNull();
    expect(screen.getByLabelText('admin code')).toBeTruthy();
  });

  it('Q-168: the library is behind the admin code, as a tab next to the AI usage', async () => {
    libraryServer(FULL);
    await signIn();
    expect(await screen.findByRole('region', { name: 'เกมต้นทาง คืนจันทราโลหิต' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'การใช้ AI ทุกเกม' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'การใช้ AI' }));
    expect(await screen.findByRole('heading', { name: 'การใช้ AI ทุกเกม' })).toBeTruthy();
  });

  it('C7: the "คลังบทพูดต่อ NPC" tab of the same page shows the good NPC lines of GEN-081 as candidates', async () => {
    libraryServer(FULL);
    await signIn();
    await screen.findByRole('region', { name: 'เกมต้นทาง คืนจันทราโลหิต' });
    fireEvent.click(screen.getByRole('button', { name: 'คลังบทพูดต่อ NPC' }));
    const good = within(await screen.findByRole('region', { name: 'บทพูดที่ผู้เล่นส่วนใหญ่ชอบ' }));
    const line = NPC_LIB.goodLines[0]!;
    expect(good.getByText('มีรา หัวเราะ "ผู้เล่นกล้าดีนี่"')).toBeTruthy();
    expect(good.getByText(new RegExp(`${line.npc.name} · 👍 ${line.up}`))).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'เกมต้นทาง คืนจันทราโลหิต' })).toBeNull();
  });
});
