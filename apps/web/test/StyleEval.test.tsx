// GEN-167: the admin page that puts the previous eval round and this one side by side for Nok to mark.
import type { StyleEvalResponse } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StyleEval } from '../src/StyleEval.tsx';

const TWO_ROUNDS = CONTRACT_FIXTURES.StyleEvalResponse[0]! as StyleEvalResponse;
const EMPTY = CONTRACT_FIXTURES.StyleEvalResponse[1]! as StyleEvalResponse;

function stub(start: StyleEvalResponse) {
  let view = start;
  const puts: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { mark: 'better' | 'same' | 'worse' | null };
        puts.push({ path, body });
        const sceneId = decodeURIComponent(path.split('/').pop()!);
        const { [sceneId]: _gone, ...others } = view.marks;
        const marks = body.mark ? { ...others, [sceneId]: body.mark } : others;
        const n = (m: string) => Object.values(marks).filter((v) => v === m).length;
        view = { ...view, marks, summary: { better: n('better'), same: n('same'), worse: n('worse'), unmarked: view.current!.scenes.length - Object.keys(marks).length } };
      }
      return Response.json(view);
    }),
  );
  return puts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GEN-167 style eval page', () => {
  it('C3: each scene shows the previous round and this round side by side', async () => {
    stub(TWO_ROUNDS);
    render(<StyleEval apiBaseUrl="http://api" token="tok" onForbidden={() => {}} />);
    const first = TWO_ROUNDS.current!.scenes[0]!;
    const row = within(await screen.findByRole('group', { name: first.title }));
    expect(row.getByText(TWO_ROUNDS.previous!.scenes[0]!.text!)).toBeTruthy();
    expect(row.getByText(first.text!)).toBeTruthy();
    expect(screen.getByText(/^รอบนี้: รอบ #2 .*Voice v2/)).toBeTruthy();
    expect(screen.getByText(/^รอบก่อน: รอบ #1 .*Voice v1/)).toBeTruthy();
  });

  it('C3: Nok marks better / same / worse; pressing the same again clears it; the summary follows', async () => {
    const puts = stub({ ...TWO_ROUNDS, marks: {}, summary: { better: 0, same: 0, worse: 0, unmarked: 3 } });
    render(<StyleEval apiBaseUrl="http://api" token="tok" onForbidden={() => {}} />);
    const scene = TWO_ROUNDS.current!.scenes[0]!;
    const row = within(await screen.findByRole('group', { name: scene.title }));
    const better = row.getByRole('button', { name: 'ดีขึ้น' });
    expect(better.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(better);
    await waitFor(() => expect(better.getAttribute('aria-pressed')).toBe('true'));
    expect(puts[0]).toEqual({ path: `/api/admin/style-eval/${TWO_ROUNDS.current!.id}/marks/${scene.sceneId}`, body: { mark: 'better' } });
    expect(screen.getByRole('status', { name: 'สรุปคะแนน' }).textContent).toMatch(/ดีขึ้น 1/);
    fireEvent.click(better);
    await waitFor(() => expect(better.getAttribute('aria-pressed')).toBe('false'));
    expect(puts[1]!.body).toEqual({ mark: null });
  });

  it('C4 / C5: a failed scene and a real-name flag are shown in words', async () => {
    stub(TWO_ROUNDS);
    render(<StyleEval apiBaseUrl="http://api" token="tok" onForbidden={() => {}} />);
    expect(await screen.findByText(/ไม่สำเร็จ/)).toBeTruthy();
    expect(screen.getByText(/ชื่อจริงหลุด/)).toBeTruthy();
  });

  it('no round yet: says how to make one', async () => {
    stub(EMPTY);
    render(<StyleEval apiBaseUrl="http://api" token="tok" onForbidden={() => {}} />);
    expect(await screen.findByText(/pnpm eval:style/)).toBeTruthy();
  });
});
