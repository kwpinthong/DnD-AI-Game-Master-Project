import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameDataEditor } from '../src/GameDataEditor.tsx';

// GEN-147: the server owner's game-data editor (a list per data set + a JSON editor the server validates).

const summary = (name: string, canUndo = false) => ({ name, file: `${name.toLowerCase()}.json`, records: 1, updatedAt: '2026-11-22T12:00:00.000Z', canUndo });
const ROW = { npc: 'โนอา', location: 'น้ำพุกลางเมือง', periods: [], weathers: [], condition: '', note: '' };
const FILE_ROW = { ...ROW, note: 'จากไฟล์ asset' };

function fakeServer() {
  const state = { value: [ROW] as unknown, canUndo: false };
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (new Headers(init?.headers).get('authorization') !== 'Bearer adm-1') return Response.json({ code: 'forbidden', message: 'หน้านี้สำหรับเจ้าของ server เท่านั้น' }, { status: 403 });
    if (url.endsWith('/api/admin/game-data')) return Response.json({ sets: [summary('NPC'), summary('NPC_Schedule', state.canUndo)] });
    if (url.endsWith('/api/admin/game-data-audit')) return Response.json({ entries: [] });
    if (url.endsWith('/api/admin/game-data-export')) return Response.json({ exportedAt: '2026-11-22T12:00:00.000Z', files: { 'npc-schedule.json': state.value } });
    if (url.endsWith('/api/admin/game-data/NPC_Schedule/asset-file')) {
      return Response.json({ set: summary('NPC_Schedule', state.canUndo), value: [FILE_ROW], changes: [{ index: 0, old: ROW, new: FILE_ROW }] });
    }
    if (url.endsWith('/api/admin/game-data/NPC_Schedule/undo')) {
      state.value = [ROW];
      state.canUndo = false;
      return Response.json({ set: summary('NPC_Schedule'), value: state.value });
    }
    if (url.endsWith('/api/admin/game-data/NPC_Schedule')) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { value: { npc: string }[] };
        if (body.value[0]?.npc === '') return Response.json({ code: 'invalid_input', message: 'ข้อมูลไม่ตรง schema', fields: { '[0].npc': 'ต้องไม่ว่าง' } }, { status: 400 });
        state.value = body.value;
        state.canUndo = true;
      }
      return Response.json({ set: summary('NPC_Schedule', state.canUndo), value: state.value });
    }
    return Response.json({ code: 'data_set_not_found', message: 'ไม่พบชุดข้อมูลนี้' }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function openSchedule() {
  render(<GameDataEditor apiBaseUrl="" token="adm-1" onForbidden={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /NPC_Schedule/ }));
  const box = (await screen.findByLabelText('JSON ของ NPC_Schedule')) as HTMLTextAreaElement;
  await waitFor(() => expect(box.value).toContain('โนอา'));
  return box;
}

describe('game data editor (GEN-147)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists every data set and opens one as JSON', async () => {
    fakeServer();
    const box = await openSchedule();
    expect(JSON.parse(box.value)).toEqual([ROW]);
    expect(screen.getByRole('button', { name: /^NPC \(/ })).toBeTruthy();
  });

  it('GEN-179 C2: a set running on its asset file shows a warning with the set and the wrong fields', async () => {
    const fallback = { message: 'game data set NPC does not match the NPC schema', fields: { '[0].grade': 'Invalid option' } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/admin/game-data') ? Response.json({ sets: [{ ...summary('NPC'), fallback }, summary('NPC_Schedule')] }) : Response.json({ entries: [] }),
      ),
    );
    render(<GameDataEditor apiBaseUrl="" token="adm-1" onForbidden={() => {}} />);
    const warning = await screen.findByRole('alert', { name: /ใช้ไฟล์ asset แทน/ });
    expect(warning.textContent).toMatch(/NPC/);
    expect(within(warning).getByText(/\[0\]\.grade: Invalid option/)).toBeTruthy();
    expect(warning.textContent).not.toMatch(/NPC_Schedule/);
  });

  it('GEN-179 C3: no warning when every set uses the DB', async () => {
    fakeServer();
    await openSchedule();
    expect(screen.queryByRole('alert', { name: /ใช้ไฟล์ asset แทน/ })).toBeNull();
  });

  it('C5: shows the wrong fields the server names; text that is not JSON is never sent', async () => {
    const calls = fakeServer();
    const box = await openSchedule();
    fireEvent.change(box, { target: { value: '[{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/JSON/);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    fireEvent.change(box, { target: { value: JSON.stringify([{ ...ROW, npc: '' }]) } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(within(alert).getByText(/\[0\]\.npc: ต้องไม่ว่าง/)).toBeTruthy());
  });

  it('C6 / C7: saves through the server, then undo brings the old value back', async () => {
    const calls = fakeServer();
    const box = await openSchedule();
    const edited = [{ ...ROW, note: 'แก้แล้ว' }];
    fireEvent.change(box, { target: { value: JSON.stringify(edited) } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    expect(await screen.findByText('บันทึกแล้ว')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ value: edited });

    fireEvent.click(screen.getByRole('button', { name: 'ย้อนการแก้ล่าสุด (undo)' }));
    await waitFor(() => expect(JSON.parse(box.value)).toEqual([ROW]));
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/NPC_Schedule/undo'))).toBe(true);
  });

  it('GEN-173 C1 / C2: "นำเข้าจากไฟล์" shows the diff; cancel sends nothing, confirm saves the file value', async () => {
    const calls = fakeServer();
    const box = await openSchedule();
    fireEvent.click(screen.getByRole('button', { name: 'นำเข้าจากไฟล์' }));
    const diff = await screen.findByRole('region', { name: 'นำเข้า NPC_Schedule จากไฟล์' });
    expect(within(diff).getByText(/1 แถวที่เปลี่ยน/)).toBeTruthy();
    expect(within(diff).getByText(/จากไฟล์ asset/)).toBeTruthy();
    fireEvent.click(within(diff).getByRole('button', { name: 'ยกเลิก' }));
    expect(screen.queryByRole('region', { name: 'นำเข้า NPC_Schedule จากไฟล์' })).toBeNull();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(JSON.parse(box.value)).toEqual([ROW]);

    fireEvent.click(screen.getByRole('button', { name: 'นำเข้าจากไฟล์' }));
    fireEvent.click(within(await screen.findByRole('region', { name: 'นำเข้า NPC_Schedule จากไฟล์' })).getByRole('button', { name: 'ยืนยันนำเข้า' }));
    expect(await screen.findByText('นำเข้าจากไฟล์แล้ว')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ value: [FILE_ROW] });
    await waitFor(() => expect(JSON.parse(box.value)).toEqual([FILE_ROW]));
  });

  it('C8: the export button downloads the JSON of every set', async () => {
    const calls = fakeServer();
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    render(<GameDataEditor apiBaseUrl="" token="adm-1" onForbidden={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'export JSON (backup)' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(calls.some((c) => c.url.endsWith('/api/admin/game-data-export'))).toBe(true);
  });
});
