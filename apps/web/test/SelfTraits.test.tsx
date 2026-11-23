// GEN-130: the "จุดแข็ง / จุดอ่อน" fold of the info panel shows the kept strength / weakness, not the personality.
import { RoomState, type CharacterView } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SelfPanel } from '../src/play/chat/InfoPanel.tsx';

afterEach(cleanup);

const room = RoomState.parse(CONTRACT_FIXTURES.RoomState[0]);
const base: CharacterView = {
  name: 'ลิน',
  appearance: 'x',
  personality: 'บุคลิกดิบ',
  hp: { current: 10, max: 30 },
  stamina: { current: 10, max: 30 },
  coins: 0,
  socialTitle: 'คนแปลกหน้า',
  conduct: 'เป็นกลาง',
  statuses: [],
  strength: { label: 'ช่างสังเกต', description: 'ลิน มองเห็นสิ่งที่คนอื่นพลาด' },
  weakness: { label: 'กลัวความมืด', description: 'ในที่มืดใจสั่น' },
  editable: false,
};

function open(character: CharacterView) {
  render(<SelfPanel data={{ character, people: [], npcs: [], seenBy: null, companions: [], inventory: null }} entries={[]} secret="" room={room} onUse={null} />);
  return screen.getByText('จุดแข็ง / จุดอ่อน').closest('details') as HTMLElement;
}

describe('GEN-130 self panel', () => {
  it('shows the strength and the weakness (label + description), not the personality', () => {
    const fold = open(base);
    for (const text of ['ช่างสังเกต', 'ลิน มองเห็นสิ่งที่คนอื่นพลาด', 'กลัวความมืด', 'ในที่มืดใจสั่น']) expect(within(fold).getByText(text)).toBeTruthy();
    expect(fold.textContent).not.toContain('บุคลิกดิบ');
    expect(fold.textContent).not.toContain('{{');
  });

  it('before a choice is kept it falls back to the personality', () => {
    const fold = open({ ...base, strength: null, weakness: null });
    expect(within(fold).getByText('บุคลิกดิบ')).toBeTruthy();
  });
});
