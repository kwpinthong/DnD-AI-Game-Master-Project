// GEN-200: the "สไตล์ของฉัน" page (Screens and Flows v2 §9) on the GEN-082 routes. The player code lives in the
// page's memory only: POST bodies, never a URL, a log or web storage.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { Gallery } from '../src/dev/Gallery.tsx';
import { MyStyle } from '../src/MyStyle.tsx';

const CODE = 'NOKA-2026';
const STYLE = {
  verbs: [
    { verb: 'OBSERVE', count: 14 },
    { verb: 'PERSUADE', count: 6 },
    { verb: 'SNEAK', count: 4 },
    { verb: 'ATTACK', count: 1 },
  ],
  summary: 'ชอบสังเกตก่อนลงมือ',
};

type Call = { method: string; url: string; body: unknown };

function styleServer() {
  const state = { style: STYLE as typeof STYLE | null, optOut: false };
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url, 'http://api').pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as { playerCode: string; optOut?: boolean }) : undefined;
      calls.push({ method, url, body });
      if (path === '/health') return Response.json({ status: 'ok', db: 'connected' });
      if (!path.startsWith('/api/style')) return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
      if (body?.playerCode !== CODE) return Response.json({ code: 'forbidden', message: 'ไม่พบรหัสผู้เล่นนี้' }, { status: 403 });
      if (path === '/api/style/delete') state.style = null;
      if (path === '/api/style/opt-out') state.optOut = body.optOut!;
      return Response.json({ style: state.style, optOut: state.optOut });
    }),
  );
  return { state, calls };
}

const open = () => render(<MyStyle apiBaseUrl="http://api" />);

async function lookUp(code = CODE) {
  fireEvent.change(screen.getByLabelText('รหัสผู้เล่น'), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'ดูสไตล์' }));
}

/** C-wide: the code is only ever in a POST/PUT body. */
function expectCodeKept(calls: Call[]) {
  for (const c of calls) expect(c.url).not.toContain(CODE);
  expect(JSON.stringify({ ...localStorage })).not.toContain(CODE);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODE);
  expect(window.location.href).not.toContain(CODE);
}

describe('GEN-200 สไตล์ของฉัน', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('C1 a code with a profile shows its top 3 verbs and its tone', async () => {
    const { calls } = styleServer();
    const log = vi.spyOn(console, 'log');
    open();
    await lookUp();
    const verbs = await screen.findByRole('list', { name: 'คำที่ใช้บ่อย' });
    expect([...verbs.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['OBSERVE', 'PERSUADE', 'SNEAK']);
    expect(screen.getByText('ชอบสังเกตก่อนลงมือ')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', url: 'http://api/api/style', body: { playerCode: CODE } }]);
    expectCodeKept(calls);
    expect(log.mock.calls.flat().join(' ')).not.toContain(CODE);
    log.mockRestore();
  });

  it('C2 delete asks first, then the profile is gone', async () => {
    const { state, calls } = styleServer();
    open();
    await lookUp();
    await screen.findByText('ชอบสังเกตก่อนลงมือ');
    fireEvent.click(screen.getByRole('button', { name: 'ลบ profile ของฉัน' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/api/style/delete'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(state.style).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ลบ profile ของฉัน' }));
    fireEvent.click(screen.getByRole('button', { name: 'ลบเลย' }));
    expect(await screen.findByText(/ยังไม่มีสไตล์ที่เก็บ/)).toBeTruthy();
    expect(state.style).toBeNull();
    expect(screen.queryByText('ชอบสังเกตก่อนลงมือ')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.find((c) => c.url.endsWith('/api/style/delete'))).toMatchObject({ method: 'POST', body: { playerCode: CODE } });
    expectCodeKept(calls);
  });

  it('C3 the toggle stops keeping my style (opt-out sent and shown)', async () => {
    const { state, calls } = styleServer();
    open();
    await lookUp();
    const toggle = await screen.findByRole('switch', { name: 'ไม่ให้เก็บสไตล์ฉัน' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(state.optOut).toBe(true));
    await waitFor(() => expect((screen.getByRole('switch', { name: 'ไม่ให้เก็บสไตล์ฉัน' }) as HTMLInputElement).checked).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/api/style/opt-out'))).toMatchObject({ method: 'PUT', body: { playerCode: CODE, optOut: true } });
    expect(screen.getByText(/เกมที่จบหลังจากนี้จะไม่เก็บสไตล์/)).toBeTruthy();
    expectCodeKept(calls);
  });

  it('C4 a wrong code says so in words without telling whether the code exists', async () => {
    const { calls } = styleServer();
    open();
    await lookUp('WRONG-0000');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('ใช้รหัสนี้ไม่ได้ ตรวจรหัสแล้วลองใหม่');
    expect(alert.textContent).not.toMatch(/ไม่พบ|ไม่มี|มีอยู่/);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ลบ profile ของฉัน' })).toBeNull();
    expect(calls.every((c) => !c.url.includes('WRONG-0000'))).toBe(true);
  });

  it('opens from the home page and in /dev/gallery', async () => {
    styleServer();
    render(<App apiBaseUrl="http://api" />);
    fireEvent.click(screen.getByRole('button', { name: 'สไตล์ของฉัน' }));
    expect(await screen.findByRole('heading', { name: 'สไตล์ของฉัน' })).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    render(<Gallery search="?screen=my-style&scenario=normal" />);
    expect(await screen.findByRole('heading', { name: 'สไตล์ของฉัน' })).toBeTruthy();
  });
});
