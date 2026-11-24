// GEN-177: the language tone (A / B / C) in the create-game form, the lobby and the admin default.
import { GameView } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateGameForm } from '../src/CreateGameForm.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { StylePanel } from '../src/StylePanel.tsx';
import { installMock, MOCK_TOKEN, mockBaseUrl } from '../src/mock/install.ts';

const noop = () => {};
let uninstall: () => void;
let cell = 0;
const base = (scenario: string) => mockBaseUrl(scenario, `t${++cell}`);
const LOBBY = GameView.parse(CONTRACT_FIXTURES.GameView[0]);

beforeEach(() => {
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.restoreAllMocks();
});

const group = () => screen.getByRole('radiogroup', { name: 'โทนภาษา' });
const radio = (name: RegExp) => within(group()).getByRole('radio', { name }) as HTMLInputElement;
const bodiesOf = (spy: { mock: { calls: unknown[][] } }, method: string) =>
  spy.mock.calls
    .map(([, init]) => init as RequestInit | undefined)
    .filter((init) => init?.method === method)
    .map((init) => JSON.parse(String(init?.body)) as unknown);

async function submitCreate() {
  for (const [label, value] of [['Create code', 'ลับเฉพาะ'], ['ชื่อเกม', 'เมืองก่อนอุกกาบาต'], ['ชื่อผู้เล่นของคุณ', 'นก'], ['PIN ของคุณ', '1234']] as const) {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }
  fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมและรับโค้ด' }));
}

describe('GEN-177 create game', () => {
  it('C6: 3 labelled tones, none picked (= the server default), and the pick is sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl={base('guest')} onCreated={onCreated} onBack={noop} />);
    expect(within(group()).getAllByRole('radio')).toHaveLength(3);
    for (const r of within(group()).getAllByRole('radio')) expect((r as HTMLInputElement).checked).toBe(false);
    fireEvent.click(radio(/ตำนานโบราณ/));
    await submitCreate();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(bodiesOf(fetchSpy, 'POST')[0]).toMatchObject({ tone: 'B' });
  });

  it('C1: without a pick the request carries no tone', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl={base('guest')} onCreated={onCreated} onBack={noop} />);
    await submitCreate();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(bodiesOf(fetchSpy, 'POST')[0]).not.toHaveProperty('tone');
  });
});

describe('GEN-177 lobby', () => {
  it('C3 / ISK-019: the tone is set at creation; the lobby shows it read-only', async () => {
    const started = { ...LOBBY, tone: 'B' as const, status: 'started' as const, startedAt: '2026-01-01T00:00:00.000Z' };
    render(<Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} initial={started} />);
    expect(screen.getByText('โทนภาษา: ตำนานโบราณ ภาษาสูง')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'โทนภาษา' })).toBeNull();
  });
});

describe('GEN-177 admin default', () => {
  it('C4 / C6: a labelled select of the 3 tones saves the default', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/admin/style-flags')) return json({ stats: [] });
      if (init?.method === 'PUT') return json({ settings: { rewrite: false, ...(JSON.parse(String(init.body)) as object) } });
      return json({ settings: { rewrite: false, defaultTone: 'A' } });
    });
    render(<StylePanel apiBaseUrl="http://localhost:5301" token="t" onForbidden={noop} />);
    const select = (await screen.findByLabelText('โทนเริ่มต้นของเกมใหม่')) as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(3);
    expect(select.value).toBe('A');
    fireEvent.change(select, { target: { value: 'C' } });
    await waitFor(() => expect(bodiesOf(fetchSpy, 'PUT')).toEqual([{ defaultTone: 'C' }]));
    await waitFor(() => expect(select.value).toBe('C'));
  });

  it('C6: the tone controls are 44px targets and use colour tokens only', () => {
    const read = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8').replace(/\r\n/g, '\n');
    expect(read('pregame.css')).toMatch(/\.pregame \.check \{[^}]*min-height: 44px/);
    expect(read('library.css')).toMatch(/\.gdata__field select[^{]*\{[^}]*min-height: 44px/);
    for (const file of ['TonePicker.tsx', 'StylePanel.tsx']) expect(read(file)).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
  });
});
