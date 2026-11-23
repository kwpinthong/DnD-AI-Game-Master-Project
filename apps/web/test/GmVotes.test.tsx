// GEN-126: the Human GM console shows the players' ถูกใจ / ไม่ถูกใจ counts per AI message with the Q-286 / Q-287 flags.
import { GmConsoleResponse } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmConsole } from '../src/GmConsole.tsx';

const at = { day: 1, phase: 'EOSORIA', turn: 1 } as const;
const VOTES = {
  players: 3,
  entries: [
    { seq: 11, kind: 'feed', at, text: 'ระฆังดังทั่วเมือง', up: 2, down: 0, good: true, avoid: false },
    { seq: 12, kind: 'narration', at, text: 'ฝนตกหนัก', up: 0, down: 2, good: false, avoid: true },
    { seq: 13, kind: 'feed', at, text: 'ตลาดเงียบ', up: 1, down: 1, good: false, avoid: false },
  ],
};

function stub(votes: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/game/gm/console')) return Response.json(GmConsoleResponse.parse(CONTRACT_FIXTURES.GmConsoleResponse[0]));
      if (url.endsWith('/api/game/gm/log')) return Response.json(CONTRACT_FIXTURES.GmLogResponse[0]);
      if (url.endsWith('/api/game/gm/votes')) return Response.json(votes);
      throw new Error(`unexpected request ${url}`);
    }),
  );
}

describe('GEN-126 C1 votes in the GM console', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('each voted message shows ถูกใจ / ไม่ถูกใจ out of all players, and the good / avoid flags', async () => {
    stub(VOTES);
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const panel = within(await screen.findByRole('region', { name: 'โหวตของผู้เล่น' }));
    const liked = await panel.findByRole('listitem', { name: /ระฆังดังทั่วเมือง/ });
    expect(liked.textContent).toContain('ถูกใจ 2');
    expect(liked.textContent).toContain('ไม่ถูกใจ 0');
    expect(liked.textContent).toContain('ตัวอย่างที่ดี');
    const disliked = panel.getByRole('listitem', { name: /ฝนตกหนัก/ });
    expect(disliked.textContent).toContain('ไม่ถูกใจ 2');
    expect(disliked.textContent).toContain('ควรเลี่ยง');
    const split = panel.getByRole('listitem', { name: /ตลาดเงียบ/ });
    expect(split.textContent).not.toMatch(/ตัวอย่างที่ดี|ควรเลี่ยง/);
    expect(panel.getByText(/ผู้เล่น 3 คน/)).toBeTruthy();
  });

  it('no votes yet says so', async () => {
    stub({ players: 3, entries: [] });
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const panel = within(await screen.findByRole('region', { name: 'โหวตของผู้เล่น' }));
    expect(panel.getByText('ยังไม่มีใครโหวต')).toBeTruthy();
  });
});
