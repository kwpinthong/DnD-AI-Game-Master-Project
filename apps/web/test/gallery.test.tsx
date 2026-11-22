// GEN-100: /dev/gallery. C1 every contract screen opens with no server, C3 the simulate buttons move the
// mock socket and the page updates in real time.
import { CONTRACT_SCREENS } from '@isekai/protocol/contract';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { Gallery } from '../src/dev/Gallery.tsx';
import { SCREEN_VIEWS } from '../src/dev/screens.tsx';
import { installMock, MOCK_TOKEN, mockBaseUrl } from '../src/mock/install.ts';
import { TOKEN_KEY } from '../src/session.ts';

let uninstall: () => void;
const realFetch = vi.fn(async () => {
  throw new Error('no server in mock mode');
});
class RealSocket {
  constructor(url: string) {
    throw new Error(`no server in mock mode: ${url}`);
  }
}

beforeEach(() => {
  localStorage.clear();
  realFetch.mockClear();
  vi.stubGlobal('fetch', realFetch);
  vi.stubGlobal('WebSocket', RealSocket);
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.unstubAllGlobals();
});

const frame = (screenId: string, scenario: string) =>
  screen.getByRole('figure', { name: new RegExp(`^${screenId} · ${scenario}$`) });

describe('C1 every screen of the contract opens without a server', () => {
  it('the gallery has one section per contract screen, in contract order', () => {
    render(<Gallery search="" />);
    const sections = screen.getAllByRole('region').filter((r) => r.dataset.screen);
    expect(sections.map((s) => s.dataset.screen)).toEqual(CONTRACT_SCREENS.map((s) => s.id));
    // each section is named by its contract title (aria-labelledby its h2; the pages inside have their own h2s)
    for (const s of CONTRACT_SCREENS) expect(screen.getByRole('region', { name: s.title }).dataset.screen).toBe(s.id);
  });

  it('every screen with a page renders it from the mock, and nothing reaches the network', async () => {
    render(<Gallery search="" />);
    // the play room frames connect through the mock socket
    await waitFor(() => expect(screen.getAllByText('เชื่อมต่อแล้ว').length).toBeGreaterThan(5));
    await screen.findAllByText('Server: ต่อได้ (database connected)');
    for (const [id, view] of Object.entries(SCREEN_VIEWS)) {
      const section = screen.getAllByRole('region').find((r) => r.dataset.screen === id)!;
      if (view.render) expect(within(section).getAllByRole('figure').length).toBeGreaterThan(0);
      else expect(within(section).getByText(/ยังไม่มีหน้า/)).toBeTruthy();
    }
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('?screen=&scenario= shows that one frame', async () => {
    render(<Gallery search="?screen=play-lock&scenario=exhausted" />);
    expect(screen.getAllByRole('figure')).toHaveLength(1);
    expect(await screen.findByText('คุณหมดแรง ต้องพักเทิร์นนี้')).toBeTruthy();
  });

  it('the app itself runs on the mock: health, lobby, then the play room', async () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);
    render(<App apiBaseUrl={mockBaseUrl('normal')} />);
    expect(await screen.findByText('Server: ต่อได้ (database connected)')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    expect(await screen.findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    expect(realFetch).not.toHaveBeenCalled();
  });
});

describe('C3 the simulate buttons drive the mock socket', () => {
  it('เปลี่ยนเทิร์น moves the play room to the next turn', async () => {
    render(<Gallery search="?screen=play-lock&scenario=normal" />);
    const f = frame('play-lock', 'normal');
    expect(await within(f).findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    expect(within(f).getByRole('heading', { name: /เทิร์น 1\/2/ })).toBeTruthy();
    act(() => fireEvent.click(within(f).getByRole('button', { name: 'เปลี่ยนเทิร์น' })));
    expect(await within(f).findByRole('heading', { name: /เทิร์น 2\/2/ })).toBeTruthy();
  });

  it('โดนผลจากคนอื่น pins a hit card', async () => {
    render(<Gallery search="?screen=play-hit&scenario=normal" />);
    const f = frame('play-hit', 'normal');
    await within(f).findByText('เชื่อมต่อแล้ว');
    expect(within(f).queryByText('ถุงเงินของคุณหายไป')).toBeNull();
    fireEvent.click(within(f).getByRole('button', { name: 'โดนผลจากคนอื่น' }));
    expect(await within(f).findByText('ถุงเงินของคุณหายไป')).toBeTruthy();
  });

  it('หลุดแล้วต่อใหม่ drops the socket and the room comes back by itself', async () => {
    render(<Gallery search="?screen=play-feed&scenario=normal" />);
    const f = frame('play-feed', 'normal');
    await within(f).findByText('เชื่อมต่อแล้ว');
    fireEvent.click(within(f).getByRole('button', { name: 'หลุดแล้วต่อใหม่' }));
    expect(await within(f).findByText(/หลุดการเชื่อมต่อ/)).toBeTruthy();
    expect(await within(f).findByText('เชื่อมต่อแล้ว', {}, { timeout: 4000 })).toBeTruthy();
    expect(within(f).getByText(/ระหว่างที่คุณหลุด/)).toBeTruthy();
  });
});
