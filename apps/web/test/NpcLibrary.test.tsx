// GEN-151: the server owner's NPC example library (on the Learning library page, Q-322): examples per NPC, add from 👍 messages / "แก้เป็น" pairs, delete.
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NpcLibrary } from '../src/NpcLibrary.tsx';

const LIB = CONTRACT_FIXTURES.NpcLibraryResponse[0]!;

function stub() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.startsWith('/api/admin/npc-library')) return Response.json(LIB);
      return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
    }),
  );
  return calls;
}

const open = () => render(<NpcLibrary apiBaseUrl="http://api" token="adm" onForbidden={() => {}} />);

describe('GEN-151 NPC example library (admin)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the examples of each NPC (tokens shown as words) and deletes one after a confirm', async () => {
    const calls = stub();
    open();
    const npc = LIB.npcs[0]!;
    const region = await screen.findByRole('region', { name: new RegExp(npc.npcName) });
    const example = npc.examples[0]!;
    expect(within(region).getByText(/ผู้เล่น/)).toBeTruthy();
    expect(region.textContent).not.toContain('{{');
    fireEvent.click(within(region).getAllByRole('button', { name: /ลบตัวอย่าง/ })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'ลบ' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.path).toBe(`/api/admin/npc-library/${example.id}`);
  });

  it('adds a 👍 message to an NPC with a scene kind', async () => {
    const calls = stub();
    open();
    const up = LIB.upvoted.find((e) => !e.inLibrary)!;
    const item = within((await screen.findByText(up.text)).closest('li')!);
    fireEvent.change(item.getByLabelText('ชนิดฉาก'), { target: { value: 'feed' } });
    fireEvent.click(item.getByRole('button', { name: /เพิ่มเข้าคลัง/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/admin/npc-library', body: { from: 'vote', gameId: up.gameId, seq: up.seq, npcId: up.npc!.id, scene: 'feed' } });
  });

  it('adds a "แก้เป็น" pair that has no NPC once one is picked', async () => {
    const calls = stub();
    open();
    const pair = LIB.candidates[0]!;
    const item = within((await screen.findByText(pair.edited)).closest('li')!);
    const button = item.getByRole('button', { name: /เพิ่มเข้าคลัง/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const npc = LIB.npcChoices[0]!;
    fireEvent.change(item.getByLabelText('NPC'), { target: { value: npc.id } });
    fireEvent.click(button);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ from: 'correction', correctionId: pair.id, npcId: npc.id });
  });

  it('GEN-084 C7: a good NPC line of GEN-081 is added to its NPC with one click (NPC picked, scene npc-dialogue)', async () => {
    const calls = stub();
    open();
    const line = LIB.goodLines[0]!;
    const item = within((await screen.findByText('มีรา หัวเราะ "ผู้เล่นกล้าดีนี่"')).closest('li')!);
    fireEvent.click(item.getByRole('button', { name: /เพิ่มเข้าคลัง/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ from: 'vote', gameId: line.gameId, seq: line.seq, npcId: line.npc.id, scene: 'npc-dialogue' });
  });
});
