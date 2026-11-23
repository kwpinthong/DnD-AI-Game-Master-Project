import type { GameLogResponse, InventoryEntry, RoomEntry } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLog } from '../src/GameHistory.tsx';
import { TurnChangesList } from '../src/play/TurnChanges.tsx';
import { Entry } from '../src/play/SelfColumn.tsx';

afterEach(cleanup);

// GEN-125: [ใช้] on an Active item, and the log under the turn result for a lost item and a karma word change.
const prism: InventoryEntry = {
  id: 'i1',
  name: 'Prism of Truth',
  rank: 'B',
  alignment: null,
  category: 'Utility',
  triggerType: 'Active',
  dailyLimit: 3,
  usesLeftToday: 3,
  description: 'เผยความจริง',
};
const entry: RoomEntry = {
  seq: 31,
  kind: 'changes',
  day: 2,
  phase: 'SOLARION',
  turn: 1,
  place: null,
  text: 'ลิน',
  changes: [
    { stat: 'stamina', delta: -2, reason: 'การกระทำในเทิร์นนี้' },
    { stat: 'item_lost', name: 'Prism of Truth', reason: 'การกระทำในเทิร์นนี้' },
    { stat: 'conduct', from: 'เป็นกลางสุดๆ', to: 'คนหัดทำดี', reason: 'การกระทำในเทิร์นนี้' },
  ],
};

describe('GEN-125 Active item and the turn log', () => {
  it('C1: an Active item with uses left has a [ใช้] button that puts it into the action box', () => {
    const onUse = vi.fn();
    render(<ul><Entry entry={prism} onUse={onUse} /></ul>);
    fireEvent.click(screen.getByRole('button', { name: 'ใช้ Prism of Truth' }));
    expect(onUse).toHaveBeenCalledWith('Prism of Truth');
    cleanup();
    render(<ul><Entry entry={{ ...prism, triggerType: 'Passive', usesLeftToday: null }} onUse={onUse} /></ul>);
    expect(screen.queryByRole('button', { name: /ใช้/ })).toBeNull();
  });

  it('C1 + C2: the log lists the lost item and the numbers; the karma word as "old → new" with no number', () => {
    render(<TurnChangesList entry={entry} />);
    const lines = within(screen.getByRole('list', { name: 'ค่าที่เปลี่ยนในเทิร์นนี้' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      'แรง -2 · การกระทำในเทิร์นนี้',
      'ของหาย: Prism of Truth · การกระทำในเทิร์นนี้',
      'ความประพฤติ เป็นกลางสุดๆ → คนหัดทำดี · การกระทำในเทิร์นนี้',
    ]);
    expect(lines[2]).not.toMatch(/\d/);
  });

  it('C3: [ประวัติ] shows the same entry with the same lines', () => {
    const log = {
      game: { id: 'g', name: 'เกมทดสอบ', mode: 'online', humanGm: false, status: 'playing', endReason: null, at: { day: 2, phase: 'SOLARION', turn: 2 }, startedAt: '2026-11-01T12:00:00.000Z' },
      you: { memberId: 'm', role: 'player' },
      members: [],
      timeline: { view: 'player', at: { day: 2, phase: 'SOLARION' }, ended: false, events: [] },
      entries: [entry],
      reveal: null,
    } as unknown as GameLogResponse;
    render(<GameLog log={log} onBack={() => {}} />);
    const item = screen.getByText(/ค่าที่เปลี่ยน:/, { selector: 'li' });
    const lines = within(item).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([
      'แรง -2 · การกระทำในเทิร์นนี้',
      'ของหาย: Prism of Truth · การกระทำในเทิร์นนี้',
      'ความประพฤติ เป็นกลางสุดๆ → คนหัดทำดี · การกระทำในเทิร์นนี้',
    ]);
  });
});
