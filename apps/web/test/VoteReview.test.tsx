// GEN-168: the server owner's list of 👎 messages, filters, "แก้เป็น" and the JSONL export.
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoteReview } from '../src/VoteReview.tsx';

const LIST = CONTRACT_FIXTURES.AdminDownvotesResponse[0]!;

function stub() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/api/admin/downvotes') return Response.json(LIST);
      if (path === '/api/admin/corrections') return Response.json(CONTRACT_FIXTURES.AdminCorrectionResponse[0]);
      if (path === '/api/admin/corrections-export') return Response.json(CONTRACT_FIXTURES.AdminCorrectionsExportResponse[0]);
      return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
    }),
  );
  return calls;
}

const open = () => render(<VoteReview apiBaseUrl="http://api" token="adm" onForbidden={() => {}} />);
const items = () => screen.getAllByRole('listitem').filter((li) => li.classList.contains('vote-review__item'));

describe('GEN-168 vote review (admin)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the 👎 messages and filters them by reason and by NPC', async () => {
    stub();
    open();
    await screen.findByText(LIST.entries[0]!.text);
    expect(items()).toHaveLength(LIST.entries.length);
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'too_long' } });
    expect(items().every((li) => /ยาวไป/.test(li.textContent!))).toBe(true);
    fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: '' } });
    const npc = LIST.entries.find((e) => e.npc)!.npc!;
    fireEvent.change(screen.getByLabelText('NPC'), { target: { value: npc.id } });
    expect(items()).toHaveLength(LIST.entries.filter((e) => e.npc?.id === npc.id).length);
  });

  it('C4 / C5: "แก้เป็น" sends the edited text (and the library flag) for that message', async () => {
    const calls = stub();
    open();
    const first = LIST.entries[0]!;
    await screen.findByText(first.text);
    const row = within(items()[0]!);
    fireEvent.click(row.getByRole('button', { name: /แก้เป็น/ }));
    fireEvent.change(row.getByLabelText('ฉบับที่ควรเป็น'), { target: { value: 'ฉบับแก้' } });
    fireEvent.click(row.getByLabelText(/ส่งเข้าคลังตัวอย่าง NPC/));
    fireEvent.click(row.getByRole('button', { name: 'บันทึกฉบับแก้' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/admin/corrections', body: { gameId: first.gameId, seq: first.seq, edited: 'ฉบับแก้', toLibrary: true } });
    expect(await row.findByText(/บันทึกแล้ว/)).toBeTruthy();
  });

  it('C6: export gives a .jsonl download of every pair', async () => {
    stub();
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'ส่งออก JSONL' }));
    const link = await screen.findByRole('link', { name: /ดาวน์โหลด/ });
    expect(link.getAttribute('download')).toMatch(/\.jsonl$/);
    expect(decodeURIComponent(link.getAttribute('href')!)).toContain(CONTRACT_FIXTURES.AdminCorrectionsExportResponse[0]!.jsonl);
  });
});
