// GEN-178: the server owner's style review tab: rounds, proposals to approve / reject, Voice versions, "run now".
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StyleReview } from '../src/StyleReview.tsx';

const STATE = CONTRACT_FIXTURES.StyleReviewResponse[0]!;

function stub() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.startsWith('/api/admin/style-review')) return Response.json(STATE);
      return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
    }),
  );
  return calls;
}

const open = () => render(<StyleReview apiBaseUrl="http://api" token="adm" onForbidden={() => {}} />);

describe('GEN-178 style review (admin)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the waiting signals, the last round counts and each proposal', async () => {
    stub();
    open();
    const proposal = STATE.proposals.find((p) => p.status === 'proposed')!;
    expect(await screen.findByText(proposal.reason)).toBeTruthy();
    expect(screen.getByRole('table', { name: /สัญญาณที่รอ/ })).toBeTruthy();
    expect(screen.getByText(STATE.rounds[0]!.patterns[0]!.summary)).toBeTruthy();
  });

  it('"run now", approve (with an edit), reject and restore call the server', async () => {
    const calls = stub();
    open();
    const proposal = STATE.proposals.find((p) => p.status === 'proposed')!;
    await screen.findByText(proposal.reason);
    fireEvent.click(screen.getByRole('button', { name: 'รันรอบทบทวนตอนนี้' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/admin/style-review/run')).toBe(true));

    const item = within(screen.getByText(proposal.reason).closest('li')!);
    fireEvent.change(item.getByLabelText('เนื้อหากฎ (JSON)'), { target: { value: JSON.stringify({ bad: 'ก', good: 'ข' }) } });
    fireEvent.click(item.getByRole('button', { name: 'อนุมัติ' }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/admin/style-review/proposals/${proposal.id}/approve`)).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/approve'))!.body).toEqual({ content: { bad: 'ก', good: 'ข' } });

    fireEvent.click(item.getByRole('button', { name: 'ไม่อนุมัติ' }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/admin/style-review/proposals/${proposal.id}/reject`)).toBe(true));

    const old = STATE.voice.versions.find((v) => !v.current)!;
    fireEvent.click(screen.getByRole('button', { name: `ย้อนเป็นเวอร์ชัน ${old.version}` }));
    await waitFor(() => expect(calls.some((c) => c.path === `/api/admin/style-review/voice/${old.version}/restore`)).toBe(true));
  });
});
