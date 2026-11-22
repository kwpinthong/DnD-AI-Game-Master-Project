import type { GameLogResponse } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { KNOWN_TOKENS_KEY, forgetToken, loadKnownTokens, rememberToken } from '../src/session.ts';

/** GEN-037 C3: the game list (every game this browser joined) and the read-only summary + log of one. */

const endedLog: GameLogResponse = {
  game: {
    id: 'g-ended',
    name: 'เมืองก่อนอุกกาบาต',
    mode: 'online',
    humanGm: false,
    status: 'ended',
    endReason: 'finale',
    at: { day: 12, phase: 'NOCTHERION', turn: 2 },
    startedAt: '2026-11-01T12:00:00.000Z',
  },
  you: { memberId: 'm-a', role: 'player' },
  members: [
    { name: 'นก', role: 'player' },
    { name: 'บี', role: 'player' },
  ],
  timeline: {
    view: 'player',
    at: { day: 12, phase: 'NOCTHERION' },
    ended: true,
    events: [{ id: 'd1-bread', day: 1, phase: 'EOSORIA', title: 'ขนมปังหายจากตลาด', status: 'resolved' }],
  },
  entries: [
    { seq: 1, kind: 'feed', day: 1, phase: 'EOSORIA', turn: 1, place: { id: 'market', name: 'ตลาด' }, text: 'เสียงโห่ดังจากกลางตลาด' },
    { seq: 4, kind: 'narration', day: 1, phase: 'EOSORIA', turn: 1, place: null, text: 'คุณเห็นเงาวิ่งหายไปหลังร้าน' },
    {
      seq: 9,
      kind: 'whisper',
      day: 2,
      phase: 'SOLARION',
      turn: 2,
      place: null,
      text: 'เจอกันที่วัด',
      whisper: { from: 'ลิน', to: 'ดาริน', mine: true },
    },
  ],
};

const playingLog: GameLogResponse = {
  ...endedLog,
  game: { ...endedLog.game, id: 'g-playing', name: 'เกมคืนวันศุกร์', status: 'playing', endReason: null, at: { day: 5, phase: 'SOLARION', turn: 1 } },
  entries: [],
};

function stubServer() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      calls.push(`${url} ${auth}`);
      if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
      if (url.endsWith('/api/game/log')) {
        if (auth === 'Bearer tok-ended') return Response.json(endedLog);
        if (auth === 'Bearer tok-playing') return Response.json(playingLog);
        return Response.json({ code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' }, { status: 401 });
      }
      return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('known sessions (GEN-037)', () => {
  it('remembers each token once, newest first, and forgets one', () => {
    rememberToken('a');
    rememberToken('b');
    rememberToken('a');
    expect(loadKnownTokens()).toEqual(['a', 'b']);
    forgetToken('a');
    expect(loadKnownTokens()).toEqual(['b']);
    expect(JSON.parse(localStorage.getItem(KNOWN_TOKENS_KEY)!)).toEqual(['b']);
  });

  it('reads a broken stored value as no tokens', () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, '{oops');
    expect(loadKnownTokens()).toEqual([]);
  });
});

describe('C3: game list and the summary + log of a finished game', () => {
  it('a join adds the game to this browser\'s list; leaving the game (logout) takes it off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
        if (url.endsWith('/api/join')) {
          return Response.json({ token: 'tok-new', expiresAt: '2026-12-22T00:00:00.000Z', created: true, member: { id: 'm-1', gameId: 'g-1', name: 'นก' } });
        }
        return Response.json({}, { status: 200 });
      }),
    );
    rememberToken('tok-old');
    render(<App apiBaseUrl="" />);
    fireEvent.change(await screen.findByLabelText('โค้ดเกม'), { target: { value: 'ABC123' } });
    fireEvent.change(screen.getByLabelText('ชื่อผู้เล่น'), { target: { value: 'นก' } });
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้าร่วม' }));
    await screen.findByText(/เข้าเกมแล้ว/);
    expect(loadKnownTokens()).toEqual(['tok-new', 'tok-old']);

    fireEvent.click(screen.getByRole('button', { name: 'ออกจากเกม' }));
    expect(loadKnownTokens()).toEqual(['tok-old']);
  });

  it('lists every game this browser joined with its status, and drops a session the server no longer knows', async () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-ended', 'tok-dead', 'tok-playing']));
    stubServer();
    render(<App apiBaseUrl="" />);

    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    const list = await screen.findByRole('list', { name: 'เกมของฉัน' });
    const items = await within(list).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('เมืองก่อนอุกกาบาต');
    expect(items[0]!.textContent).toContain('จบแล้ว');
    expect(items[1]!.textContent).toContain('เกมคืนวันศุกร์');
    expect(items[1]!.textContent).toContain('กำลังเล่น');
    expect(items[1]!.textContent).toContain('วันที่ 5');
    expect(loadKnownTokens()).toEqual(['tok-ended', 'tok-playing']);
  });

  it('opens a finished game read-only: members, timeline, own feed / narration / whispers; no way to act', async () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-ended']));
    stubServer();
    render(<App apiBaseUrl="" />);

    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ดูสรุป เมืองก่อนอุกกาบาต' }));

    const summary = await screen.findByRole('region', { name: 'สรุปเกม เมืองก่อนอุกกาบาต' });
    const s = within(summary);
    expect(s.getByText(/^จบแล้ว · หยุดที่ วันที่ 12/)).toBeTruthy();
    expect(within(s.getByRole('list', { name: 'ผู้เล่น' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['นก', 'บี']);
    expect(within(s.getByRole('list', { name: 'เหตุการณ์' })).getByText(/ขนมปังหายจากตลาด/)).toBeTruthy();
    const log = within(s.getByRole('list', { name: 'บันทึกของคุณ' }));
    expect(log.getByText(/เสียงโห่ดังจากกลางตลาด/)).toBeTruthy();
    expect(log.getByText(/คุณเห็นเงาวิ่งหายไปหลังร้าน/)).toBeTruthy();
    expect(log.getByText(/ลิน → ดาริน/)).toBeTruthy();
    expect(s.queryByRole('textbox')).toBeNull();
    expect(s.getByText(/ความลับของทุกคนจะเปิดในหน้าฉากจบ/)).toBeTruthy();

    fireEvent.click(s.getByRole('button', { name: 'กลับไปรายการเกม' }));
    expect(await screen.findByRole('list', { name: 'เกมของฉัน' })).toBeTruthy();
  });

  it('says so when this browser has no game yet', async () => {
    stubServer();
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    expect(await screen.findByText('ยังไม่มีเกมในเครื่องนี้ เข้าร่วมหรือสร้างเกมก่อน')).toBeTruthy();
  });
});
