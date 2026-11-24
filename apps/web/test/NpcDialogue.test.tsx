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
const radio = (name: RegExp) => within(group()).getByRole('radio', { name }) as HTMLInputElement;
const bodiesOf = (spy: { mock: { calls: unknown[][] } }, method: string) =>
  spy.mock.calls
    .map(([, init]) => init as RequestInit | undefined)
    .filter((init) => init?.method === method)
    .map((init) => JSON.parse(String(init?.body)) as unknown);

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

describe('GEN-127 C2 / C3 lobby (ISK-019: set at creation, read-only for everyone)', () => {
  it('every member reads the level; nothing in the lobby changes it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} initial={{ ...LOBBY, npcDialogue: 'high' }} pollMs={60_000} />);
    expect(screen.getByText('บทพูดของ NPC: เยอะ')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'บทพูดของ NPC' })).toBeNull();
    expect(bodiesOf(fetchSpy, 'PATCH')).toEqual([]);
  });
});
