// GEN-089: the phone tabs of the Play screen (C2, C3, C4, C5). Layout widths / tap targets are measured in Chrome; jsdom has no layout.
import type { RoomEntry } from '@isekai/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMock, MOCK_TOKEN, mockBaseUrl, mockRoom } from '../src/mock/install.ts';
import { dotTabs, tabCounts } from '../src/play/tabs.ts';
import { PlayRoom } from '../src/PlayRoom.tsx';

const noop = () => {};
let uninstall: () => void;
let cell = 0;

beforeEach(() => {
  localStorage.clear();
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
});

function playRoom(scenario: string) {
  const baseUrl = mockBaseUrl(scenario, `t${++cell}`);
  render(<PlayRoom apiBaseUrl={baseUrl} token={MOCK_TOKEN} onBack={noop} onGameList={noop} onNeedCharacter={noop} onSessionLost={noop} />);
  return baseUrl;
}
const bar = () => screen.findByRole('navigation', { name: 'แท็บหน้าเล่น' });
const tab = async (name: string) => within(await bar()).getByRole('button', { name: new RegExp(`^${name}`) });
const hasDot = async (name: string) => within(await tab(name)).queryByRole('img', { name: 'มีของใหม่' }) !== null;
const entry = (kind: RoomEntry['kind'], extra: Partial<RoomEntry> = {}) => ({ seq: 1, kind, place: null, text: 'x', ...extra }) as RoomEntry;

describe('tab logic', () => {
  it('counts the feed for สถานที่ and everything yours alone (not your own whisper) for ส่วนตัว', () => {
    const entries = [entry('feed'), entry('narration'), entry('hit'), entry('whisper', { whisper: { mine: true } as RoomEntry['whisper'] }), entry('whisper', { whisper: { mine: false } as RoomEntry['whisper'] })];
    expect(tabCounts(entries)).toMatchObject({ place: 1, private: 3 });
  });

  it('a dot only for a tab that is not open and has more than it had', () => {
    const counts = { place: 2, private: 3, self: 0, action: 0 };
    const seen = { place: 2, private: 1, self: 0, action: 0 };
    expect([...dotTabs(counts, seen, 'place')]).toEqual(['private']);
    expect([...dotTabs(counts, seen, 'private')]).toEqual([]);
  });
});

describe('C2 a private narration on another tab', () => {
  it('ส่วนตัว gets a dot, and the dot is gone once it is opened', async () => {
    const baseUrl = playRoom('normal');
    await within(await bar()).findAllByRole('button');
    fireEvent.click(await tab('ส่วนตัว')); // open it once: what is there is seen
    fireEvent.click(await tab('สถานที่'));
    expect(await hasDot('ส่วนตัว')).toBe(false);
    act(() => (mockRoom(baseUrl) as unknown as { addEntry: (e: object) => void }).addEntry({ kind: 'narration', place: null, text: 'เสียงกระซิบจากเงามืด' }));
    await waitFor(async () => expect(await hasDot('ส่วนตัว')).toBe(true));
    expect(await hasDot('สถานที่')).toBe(false);
    fireEvent.click(await tab('ส่วนตัว'));
    expect(await hasDot('ส่วนตัว')).toBe(false);
  });
});

describe('C3 a hit shows over every tab until [รับทราบ]', () => {
  it('the hit card is on screen (not display:none by the tabs) on each tab, then goes after รับทราบ', async () => {
    const baseUrl = playRoom('normal');
    await bar();
    act(() => mockRoom(baseUrl).hit());
    const card = await screen.findByRole('button', { name: /รับทราบ/ });
    const pin = card.closest('.play-pin')!;
    const body = pin.closest('.play-body')!;
    // the CSS keeps `.play-pin` (and its private column) visible on every tab: the pin is never inside a hidden panel
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'play', 'play.css'), 'utf8');
    expect(css).toMatch(/\.play-private > :not\(\.play-pin\)/);
    expect(css).not.toMatch(/data-tab='[a-z]+'\]\s+\.play-private\s*[,{]/);
    for (const name of ['สถานที่', 'ตัวเรา', 'action', 'ส่วนตัว']) {
      fireEvent.click(await tab(name));
      expect(body.contains(pin)).toBe(true);
      expect(screen.getByRole('button', { name: /รับทราบ/ })).toBe(card);
    }
    fireEvent.click(card);
    await waitFor(() => expect(screen.queryByRole('button', { name: /รับทราบ/ })).toBeNull());
  });
});

describe('C4 / C5 the same components, so state survives a tab switch (and a switch of layout)', () => {
  it('the typed action is still there after another tab, in the very same textarea', async () => {
    playRoom('normal');
    const box = (await screen.findByRole('form', { name: 'ส่ง action' })).querySelector('textarea')!;
    fireEvent.click(await tab('action'));
    fireEvent.change(box, { target: { value: 'ฉันเดินไปหาพ่อค้า' } });
    for (const name of ['ตัวเรา', 'ส่วนตัว', 'สถานที่', 'action']) fireEvent.click(await tab(name));
    const after = screen.getByRole('form', { name: 'ส่ง action' }).querySelector('textarea')!;
    expect(after).toBe(box);
    expect(after.value).toBe('ฉันเดินไปหาพ่อค้า');
  });

  it('the three desktop columns are always rendered; the tab bar is hidden by CSS from 768 up, not by React', async () => {
    playRoom('normal');
    await bar();
    const play = await screen.findByRole('region', { name: 'ห้องเล่น' });
    expect([...play.querySelectorAll('.play-body > *')].map((c) => c.className)).toEqual(['play-self', 'play-place', 'play-private']);
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'play', 'play.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.play-mtabs\s*\{\s*display:\s*none;\s*\}/);
    expect(css).toMatch(/@container\s+play\s*\(max-width:\s*767\.98px\)/);
  });
});
