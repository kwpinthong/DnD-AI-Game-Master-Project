// GEN-127: the NPC dialogue level (น้อย / ปกติ / เยอะ) in the create-game form and in the lobby.
import { GameView } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateGameForm } from '../src/CreateGameForm.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { installMock, MOCK_TOKEN, mockBaseUrl } from '../src/mock/install.ts';

const noop = () => {};
let uninstall: () => void;
let cell = 0;
const base = (scenario: string) => mockBaseUrl(scenario, `n${++cell}`);
const LOBBY = GameView.parse(CONTRACT_FIXTURES.GameView[0]);

beforeEach(() => {
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.restoreAllMocks();
});

const group = () => screen.getByRole('radiogroup', { name: 'บทพูดของ NPC' });
const radio = (name: string) => within(group()).getByRole('radio', { name }) as HTMLInputElement;
const bodiesOf = (spy: ReturnType<typeof vi.spyOn>, method: string) =>
  spy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method).map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);

describe('GEN-127 C1 create game', () => {
  it('shows 3 options with a description each, normal by default, and sends the pick', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl={base('guest')} onCreated={onCreated} onBack={noop} />);
    expect(within(group()).getAllByRole('radio')).toHaveLength(3);
    expect(radio(/น้อย/).checked).toBe(false);
    expect(radio(/ปกติ/).checked).toBe(true);
    expect(radio(/เยอะ/).checked).toBe(false);
    expect(within(group()).getAllByText(/NPC/).length).toBeGreaterThanOrEqual(3);

    fireEvent.click(radio(/เยอะ/));
    for (const [label, value] of [['Create code', 'ลับเฉพาะ'], ['ชื่อเกม', 'เมืองก่อนอุกกาบาต'], ['ชื่อผู้เล่นของคุณ', 'นก'], ['PIN ของคุณ', '1234']] as const) {
      const input = screen.getByLabelText(label);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    }
    fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมและรับโค้ด' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(bodiesOf(fetchSpy, 'POST')[0]).toMatchObject({ npcDialogue: 'high' });
  });
});

describe('GEN-127 C2 / C3 lobby', () => {
  it('the owner changes the level before the start (PATCH /api/game)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} />);
    await screen.findByRole('radiogroup', { name: 'บทพูดของ NPC' });
    expect(radio(/ปกติ/).checked).toBe(true);
    fireEvent.click(radio(/น้อย/));
    await waitFor(() => expect(bodiesOf(fetchSpy, 'PATCH')).toEqual([{ npcDialogue: 'low' }]));
  });

  it('another member sees the level but cannot change it', async () => {
    const other = { ...LOBBY, npcDialogue: 'high' as const, you: { ...LOBBY.you, isOwner: false } };
    render(<Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} initial={other} pollMs={60_000} />);
    expect(radio(/เยอะ/).checked).toBe(true);
    for (const r of within(group()).getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
  });

  it('after the start the control is locked for the owner too', async () => {
    const started = { ...LOBBY, status: 'started' as const, startedAt: '2026-01-01T00:00:00.000Z' };
    render(<Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} initial={started} />);
    for (const r of within(group()).getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
  });
});
