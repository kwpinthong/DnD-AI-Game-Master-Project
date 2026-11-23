import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameDataEditor } from '../src/GameDataEditor.tsx';

// GEN-172: NPC_Schedule and NPC are edited one record / field at a time in a form (not raw JSON), through the
// same server API (schema check, backup, audit, undo).

const summary = (name: string, canUndo = false) => ({ name, file: `${name.toLowerCase()}.json`, records: 2, updatedAt: '2026-11-22T12:00:00.000Z', canUndo });
const ROW1 = { npc: 'โนอา', location: 'น้ำพุกลางเมือง', periods: ['EOSORIA'], weathers: [], condition: '', note: '', extra: { sheet_col: 'เก็บไว้' } };
const ROW2 = { npc: 'ลูเซีย', location: 'โบสถ์', periods: [], weathers: ['Rain'], condition: 'ฝนตก', note: '' };
const NPC = {
  grade: 'F',
  alignments: ['Good', 'Evil'],
  name: 'โนอา (Noa) — เด็กขอทาน',
  aliases: ['โนอา', 'Noa'],
  trueName: 'Seraphiel',
  lore: 'เด็กหนุ่มผอมโซ',
  unlockCondition: '',
  rewards: '',
  matchVerbTags: ['PERSUADE'],
  matchTargetTags: [],
  publicAlias: 'เด็กขอทาน',
  farewell: '',
  note: '',
};

function fakeServer() {
  const original: Record<string, unknown[]> = { NPC_Schedule: [ROW1, ROW2], NPC: [NPC] };
  const state: Record<string, { value: unknown[]; history: unknown[][] }> = {
    NPC_Schedule: { value: original.NPC_Schedule!, history: [] },
    NPC: { value: original.NPC!, history: [] },
  };
  const calls: { method: string; url: string; body?: { value: unknown[] } }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith('/api/admin/game-data')) return Response.json({ sets: Object.keys(state).map((n) => summary(n, state[n]!.history.length > 0)) });
      if (url.endsWith('/api/admin/game-data-audit')) return Response.json({ entries: [] });
      const name = /\/api\/admin\/game-data\/(\w+)/.exec(url)?.[1] ?? '';
      const set = state[name];
      if (!set) return Response.json({ code: 'data_set_not_found', message: 'ไม่พบชุดข้อมูลนี้' }, { status: 404 });
      if (url.endsWith('/undo')) set.value = set.history.pop() ?? set.value;
      else if (method === 'PUT') {
        const value = (JSON.parse(String(init?.body)) as { value: Record<string, unknown>[] }).value;
        const empty = value.findIndex((r) => r.npc === '' || r.name === '');
        if (empty >= 0) return Response.json({ code: 'invalid_input', message: 'ข้อมูลไม่ตรง schema', fields: { [`[${empty}].${name === 'NPC' ? 'name' : 'npc'}`]: 'ต้องไม่ว่าง' } }, { status: 400 });
        set.history.push(set.value);
        set.value = value;
      }
      return Response.json({ set: summary(name, set.history.length > 0), value: set.value });
    }),
  );
  return { calls, state, puts: () => calls.filter((c) => c.method === 'PUT') };
}

async function open(name: 'NPC_Schedule' | 'NPC') {
  render(<GameDataEditor apiBaseUrl="" token="adm-1" onForbidden={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name} \\(`) }));
  return screen.findByRole('group', { name: /^แถว 1:/ });
}
const row = (n: number) => screen.getByRole('group', { name: new RegExp(`^แถว ${n}:`) });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

describe('record / field form for NPC_Schedule and NPC (GEN-172)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('C1: changing the period of one NPC_Schedule row saves only that change (other rows and unknown columns kept)', async () => {
    const server = fakeServer();
    const first = await open('NPC_Schedule');
    expect((within(first).getByLabelText('NPC') as HTMLInputElement).value).toBe('โนอา');
    fireEvent.click(within(first).getByRole('checkbox', { name: 'EOSORIA' }));
    fireEvent.click(within(first).getByRole('checkbox', { name: 'SOLARION' }));
    save();
    expect(await screen.findByText('บันทึกแล้ว')).toBeTruthy();
    expect(server.puts()).toHaveLength(1);
    expect(server.puts()[0]!.body).toEqual({ value: [{ ...ROW1, periods: ['SOLARION'] }, ROW2] });
  });

  it('C2: a wrong value shows the problem at that input; the saved value is unchanged', async () => {
    const server = fakeServer();
    await open('NPC_Schedule');
    fireEvent.change(within(row(2)).getByLabelText('NPC'), { target: { value: '' } });
    save();
    const input = within(row(2)).getByLabelText('NPC');
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toMatch(/ต้องไม่ว่าง/);
    expect(within(row(1)).getByLabelText('NPC').getAttribute('aria-invalid')).not.toBe('true');
    expect(server.state.NPC_Schedule!.value).toEqual([ROW1, ROW2]);
  });

  it('C3: add and delete a row, each saved and undone', async () => {
    const server = fakeServer();
    await open('NPC_Schedule');
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มแถว' }));
    const added = row(3);
    fireEvent.change(within(added).getByLabelText('NPC'), { target: { value: 'มาร์คัส' } });
    fireEvent.change(within(added).getByLabelText('สถานที่'), { target: { value: 'ตลาด' } });
    save();
    expect(await screen.findByText('บันทึกแล้ว')).toBeTruthy();
    expect(server.puts()[0]!.body!.value).toEqual([ROW1, ROW2, { npc: 'มาร์คัส', location: 'ตลาด', periods: [], weathers: [], condition: '', note: '' }]);

    fireEvent.click(screen.getByRole('button', { name: 'ย้อนการแก้ล่าสุด (undo)' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: /^แถว 3:/ })).toBeNull());

    fireEvent.click(within(row(1)).getByRole('button', { name: 'ลบแถว 1' }));
    expect((within(row(1)).getByLabelText('NPC') as HTMLInputElement).value).toBe('ลูเซีย');
    save();
    await waitFor(() => expect(server.puts()).toHaveLength(2));
    expect(server.puts()[1]!.body!.value).toEqual([ROW2]);
    await screen.findByText('บันทึกแล้ว');
    fireEvent.click(screen.getByRole('button', { name: 'ย้อนการแก้ล่าสุด (undo)' }));
    await waitFor(() => expect((within(row(1)).getByLabelText('NPC') as HTMLInputElement).value).toBe('โนอา'));
    expect(server.state.NPC_Schedule!.value).toEqual([ROW1, ROW2]);
  });

  it('NPC: fields (list, choice, long text) edit one record; Public_Alias / Farewell go through', async () => {
    const server = fakeServer();
    const first = await open('NPC');
    expect((within(first).getByLabelText('ชื่อเรียกสั้น (คั่นด้วย ,)') as HTMLInputElement).value).toBe('โนอา, Noa');
    fireEvent.change(within(first).getByLabelText('ชื่อเรียกสั้น (คั่นด้วย ,)'), { target: { value: 'โนอา, Noa, นก' } });
    fireEvent.change(within(first).getByLabelText('ชื่อที่ผู้เล่นเห็น (Public_Alias)'), { target: { value: 'นก' } });
    fireEvent.change(within(first).getByLabelText('คำลา (Farewell)'), { target: { value: 'ไว้เจอกันใหม่' } });
    fireEvent.change(within(first).getByLabelText('Grade'), { target: { value: 'B' } });
    fireEvent.click(within(first).getByRole('checkbox', { name: 'Evil' }));
    save();
    await waitFor(() => expect(server.puts()).toHaveLength(1));
    expect(server.puts()[0]!.body!.value).toEqual([{ ...NPC, grade: 'B', alignments: ['Good'], aliases: ['โนอา', 'Noa', 'นก'], publicAlias: 'นก', farewell: 'ไว้เจอกันใหม่' }]);
  });

  it('C4: every input and button of the form is labelled; the form styles use tokens only with 44px targets', async () => {
    fakeServer();
    await open('NPC_Schedule');
    const form = screen.getByRole('region', { name: 'แก้ NPC_Schedule' });
    const nameOf = (el: HTMLElement) => ((el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent ?? '').trim() || el.getAttribute('aria-label');
    for (const el of [...within(form).getAllByRole('textbox'), ...within(form).getAllByRole('checkbox'), ...within(form).getAllByRole('button')]) {
      expect(nameOf(el), el.outerHTML).toBeTruthy();
    }
    const css = readFileSync(join(__dirname, '../src/library.css'), 'utf8').replace(/\r\n/g, '\n');
    const block = css.slice(css.indexOf('/* GEN-172'), css.indexOf('.lib {'));
    expect(block).toMatch(/\.gdata__field input[^{]*\{[^}]*min-height: 44px/);
    expect(block).toMatch(/\.gdata__check[^{]*\{[^}]*min-height: 44px/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
