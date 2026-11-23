// GEN-149: tap an NPC at your place to open a chat box; the reply comes at once, a quota per period, "ลองใหม่" on an AI error.
import { RoomState } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HereList } from '../src/play/PlaceColumn.tsx';
import { NpcChatBox, type NpcChatApi } from '../src/play/chat/NpcChat.tsx';
import type { PlayData } from '../src/play/play-api.ts';

afterEach(cleanup);

const room = RoomState.parse(CONTRACT_FIXTURES.RoomState[0]);
const npc = { ref: 'r-merchant', name: 'พ่อค้าเร่ผู้สวมแว่นหนา' };
const data: PlayData = {
  character: undefined,
  people: [{ ref: 'p1', name: null, appearance: 'ชายร่างสูง', socialTitle: 'คนแปลกหน้า', injury: 'ปกติ' } as PlayData['people'][number]],
  npcs: [{ ref: npc.ref, name: npc.name, nameRevealed: false } as PlayData['npcs'][number]],
  seenBy: 2,
  companions: [],
  inventory: null,
};

function api(overrides: Partial<NpcChatApi> = {}): NpcChatApi {
  return {
    status: vi.fn().mockResolvedValue({ perPeriod: 5, left: 3 }),
    send: vi.fn().mockResolvedValue({ ok: true, data: { reply: 'คึกคักดี', suggestion: null, status: { perPeriod: 5, left: 2 } } }),
    ...overrides,
  };
}

describe('GEN-149 NPC chat (web)', () => {
  it('C5: each NPC here has a [คุย] button (not the people); it opens the chat with that NPC', () => {
    const onChat = vi.fn();
    render(<HereList room={room} data={data} onSave={null} onChat={onChat} />);
    const buttons = screen.getAllByRole('button', { name: /^คุยกับ/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: `คุยกับ ${npc.name}` }));
    expect(onChat).toHaveBeenCalledWith(npc);
  });

  it('C5: without NPCs at the place there is nothing to open', () => {
    render(<HereList room={room} data={{ ...data, npcs: [] }} onSave={null} onChat={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^คุยกับ/ })).toBeNull();
  });

  it('C1: a message gets the reply in the box and the quota goes down', async () => {
    const chat = api();
    render(<NpcChatBox npc={npc} api={chat} onClose={() => {}} />);
    await screen.findByText(/เหลือ 3\/5/);
    fireEvent.change(screen.getByLabelText(/ข้อความถึง/), { target: { value: 'ตลาดคึกคักไหม' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ส่ง' })));
    expect(chat.send).toHaveBeenCalledWith(npc.ref, 'ตลาดคึกคักไหม', false);
    expect(screen.getByText('ตลาดคึกคักไหม')).toBeTruthy();
    expect(screen.getByText('คึกคักดี')).toBeTruthy();
    expect(screen.getByText(/เหลือ 2\/5/)).toBeTruthy();
  });

  it('C2: no messages left = the send button is off and says why', async () => {
    render(<NpcChatBox npc={npc} api={api({ status: vi.fn().mockResolvedValue({ perPeriod: 5, left: 0 }) })} onClose={() => {}} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'ส่ง' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/ครบ 5 ข้อความ.*ช่วงถัดไป/)).toBeTruthy();
  });

  it('C3: a suggestion to act is shown under the reply; a whisper is sent as one', async () => {
    const chat = api({ send: vi.fn().mockResolvedValue({ ok: true, data: { reply: 'ไม่ให้ฟรีหรอก', suggestion: 'ลองต่อรองซื้อเป็น action', status: { perPeriod: 5, left: 2 } } }) });
    render(<NpcChatBox npc={npc} api={chat} onClose={() => {}} />);
    await screen.findByText(/เหลือ 3\/5/);
    fireEvent.click(screen.getByLabelText(/กระซิบ/));
    fireEvent.change(screen.getByLabelText(/ข้อความถึง/), { target: { value: 'ขอดาบหน่อย' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ส่ง' })));
    expect(chat.send).toHaveBeenCalledWith(npc.ref, 'ขอดาบหน่อย', true);
    expect(screen.getByText(/ลองต่อรองซื้อเป็น action/)).toBeTruthy();
  });

  it('C8: an AI error shows the reason and [ลองใหม่], which sends the same message again', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'NPC ยังไม่ตอบ ลองใหม่อีกครั้ง', retry: true })
      .mockResolvedValueOnce({ ok: true, data: { reply: 'ว่าไง', suggestion: null, status: { perPeriod: 5, left: 2 } } });
    render(<NpcChatBox npc={npc} api={api({ send })} onClose={() => {}} />);
    await screen.findByText(/เหลือ 3\/5/);
    fireEvent.change(screen.getByLabelText(/ข้อความถึง/), { target: { value: 'สวัสดี' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ส่ง' })));
    expect(screen.getByRole('alert').textContent).toContain('NPC ยังไม่ตอบ');
    expect(screen.getByText(/เหลือ 3\/5/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' })));
    expect(send).toHaveBeenLastCalledWith(npc.ref, 'สวัสดี', false);
    expect(screen.getByText('ว่าไง')).toBeTruthy();
  });
});
