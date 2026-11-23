import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameDataEditor } from '../src/GameDataEditor.tsx';

// GEN-147: the server owner's game-data editor (a list per data set + a JSON editor the server validates).

const summary = (name: string, canUndo = false) => ({ name, file: `${name.toLowerCase()}.json`, records: 1, updatedAt: '2026-11-22T12:00:00.000Z', canUndo });
const ROW = { npc: 'โนอา', location: 'น้ำพุกลางเมือง', periods: [], weathers: [], condition: '', note: '' };

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
