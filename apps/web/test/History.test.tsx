import type { GameLogResponse, GameRatingView } from '@isekai/protocol';
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
  reveal: {
    path: 'none',
    players: [
      {
        memberId: 'm-a',
        lobbyName: 'นก',
        characterName: 'ลิน',
        karma: -45,
        karmaTier: 'ชั่วร้าย',
        outcome: 'survived',
        spawn: 'โรงเตี๊ยมและกิลด์นักเดินทาง',
        companions: ['มาร์คัส'],
        secretActions: [{ day: 3, phase: 'NOCTHERION', turn: 1, text: 'แอบขโมยแผนที่ดาว', sourceRef: '3-NOCTHERION-1-1' }],
      },
      {
        memberId: 'm-b',
        lobbyName: 'บี',
        characterName: 'ดาริน',
        karma: 12,
        karmaTier: 'ดีเล็กน้อย',
        outcome: 'defeated',
        spawn: null,
        companions: [],
        secretActions: [],
      },
    ],
  },
};

const playingLog: GameLogResponse = {
  ...endedLog,
  game: { ...endedLog.game, id: 'g-playing', name: 'เกมคืนวันศุกร์', status: 'playing', endReason: null, at: { day: 5, phase: 'SOLARION', turn: 1 } },
  entries: [],
  reveal: null,
};

/** `rating`: the GEN-078 endpoints of the ended game, kept in memory; every write is in `ratingCalls`. */
function stubServer() {
  const calls: string[] = [];
  const ratingCalls: { method: string; path: string; body: unknown }[] = [];
  const rating: GameRatingView = { mine: null, liked: [], thumbs: {}, average: null, raters: 0, members: 2, eligible: false, blocker: 'too_few_raters' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      calls.push(`${url} ${auth}`);
      if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
      const path = url.slice(url.indexOf('/api/'));
      if (path.startsWith('/api/game/rating')) {
        const method = init?.method ?? 'GET';
        if (auth !== 'Bearer tok-ended') return Response.json({ code: 'not_allowed', message: 'ให้คะแนนได้เมื่อเกมจบแล้วเท่านั้น' }, { status: 409 });
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (method !== 'GET') ratingCalls.push({ method, path, body });
        if (path === '/api/game/rating' && method === 'PUT') {
          const sent = body as { score: number; comment?: string };
          rating.mine = { score: sent.score, comment: sent.comment ?? '' };
          rating.raters = 1;
          rating.average = sent.score;
        }
        const ref = decodeURIComponent(path.split('/likes/')[1] ?? '');
        if (ref && method === 'PUT') {
          rating.liked = [ref];
          rating.thumbs = { [ref]: 3 };
        }
        if (ref && method === 'DELETE') {
          rating.liked = [];
          rating.thumbs = { [ref]: 2 };
        }
        return Response.json({ rating });
      }
      if (url.endsWith('/api/game/log')) {
        if (auth === 'Bearer tok-ended') return Response.json(endedLog);
        if (auth === 'Bearer tok-playing') return Response.json(playingLog);
        return Response.json({ code: 'unauthorized', message: 'ยังไม่ได้เข้าเกม หรือ session หมดอายุ' }, { status: 401 });
      }
      return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
    }),
  );
  return Object.assign(calls, { ratingCalls, rating });
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
    // The only thing to fill in is the rating form (GEN-078).
    const form = s.getByRole('region', { name: 'ให้คะแนนเกม' });
    expect(s.queryAllByRole('textbox').filter((box) => !form.contains(box))).toEqual([]);

    fireEvent.click(s.getByRole('button', { name: 'กลับไปรายการเกม' }));
    expect(await screen.findByRole('list', { name: 'เกมของฉัน' })).toBeTruthy();
  });

  it('C5 (GEN-059): a finished game reveals every player: real name, karma tier (number small), outcome, spawn, companions, Secret actions', async () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-ended']));
    stubServer();
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ดูสรุป เมืองก่อนอุกกาบาต' }));

    const reveal = within(await screen.findByRole('region', { name: 'ความลับของทุกคน' }));
    expect(reveal.getByText(/อุกกาบาตชนเมือง/)).toBeTruthy();
    const lin = within(reveal.getByRole('article', { name: 'นก' }));
    expect(lin.getByText('ลิน')).toBeTruthy();
    // Q-196: the tier word is the label, the number small beside it.
    expect(lin.getByText('ชั่วร้าย')).toBeTruthy();
    expect(lin.getByText('(-45)').tagName).toBe('SMALL');
    expect(lin.getByText(/รอด/)).toBeTruthy();
    expect(lin.getByText(/โรงเตี๊ยมและกิลด์นักเดินทาง/)).toBeTruthy();
    expect(lin.getByText(/มาร์คัส/)).toBeTruthy();
    // Q-270: the Secret action is in the one list, named for its player, not in the card
    expect(lin.queryByText(/แอบขโมยแผนที่ดาว/)).toBeNull();
    const secret = within(reveal.getByRole('list', { name: 'สิ่งที่ทำไว้ลับ ๆ' })).getByText(/แอบขโมยแผนที่ดาว/);
    expect(secret.closest('li')!.textContent).toContain('ลิน (นก)');
    const darin = within(reveal.getByRole('article', { name: 'บี' }));
    expect(darin.getByText(/พ่ายแพ้/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'ให้คะแนนเกม' })).toBeTruthy();
  });

  async function openEnded() {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-ended']));
    const server = stubServer();
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ดูสรุป เมืองก่อนอุกกาบาต' }));
    const form = within(await screen.findByRole('region', { name: 'ให้คะแนนเกม' }));
    await form.findByRole('group', { name: /คะแนน 1/ });
    return { server, form };
  }

  // Q-273: the end page's form is GEN-091's (radio scores 1-10); the behaviour is GEN-078's.
  it('GEN-078 C1: on an ended game a member sends 9 + a comment and the page says the score is sent', async () => {
    const { server, form } = await openEnded();
    expect(form.queryByText(/ส่งแล้ว/)).toBeNull();
    fireEvent.click(form.getByRole('radio', { name: '9' }));
    fireEvent.change(form.getByLabelText('ความเห็น (ไม่บังคับ)'), { target: { value: 'สนุกมาก ทำอีกนะ' } });
    fireEvent.click(form.getByRole('button', { name: 'ส่งคะแนน' }));
    expect(await form.findByText(/ส่งแล้ว/)).toBeTruthy();
    expect(server.ratingCalls).toEqual([{ method: 'PUT', path: '/api/game/rating', body: { score: 9, comment: 'สนุกมาก ทำอีกนะ' } }]);
    // C6: the score can be changed.
    expect(form.getByRole('button', { name: 'แก้คะแนน' })).toBeTruthy();
  });

  it('GEN-078 C2: no score chosen: an error, and nothing is sent', async () => {
    const { server, form } = await openEnded();
    fireEvent.click(form.getByRole('button', { name: 'ส่งคะแนน' }));
    expect((await form.findByRole('alert')).textContent).toBe('เลือกคะแนน 1–10');
    expect(server.ratingCalls).toEqual([]);
    // Only whole numbers 1–10 can be chosen.
    expect(form.getAllByRole('radio').map((o) => (o as HTMLInputElement).value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  });

  it('GEN-078 C7: 👍 on a revealed action marks it liked; pressing again takes it back', async () => {
    const { server } = await openEnded();
    const lin = within(await screen.findByRole('list', { name: 'สิ่งที่ทำไว้ลับ ๆ' }));
    const like = await lin.findByRole('button', { name: /ชอบการตัดสินนี้: แอบขโมยแผนที่ดาว/ });
    const count = (n: number) => lin.getByLabelText(`👍 ${n} คน`);
    expect(count(0)).toBeTruthy();
    expect(like.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(like);
    await lin.findByRole('button', { name: /ชอบการตัดสินนี้: แอบขโมยแผนที่ดาว/, pressed: true });
    // Q-261: the total 👍 count (from the server) goes up when liked and down when taken back
    expect(count(3)).toBeTruthy();
    fireEvent.click(lin.getByRole('button', { name: /ชอบการตัดสินนี้: แอบขโมยแผนที่ดาว/ }));
    await lin.findByRole('button', { name: /ชอบการตัดสินนี้: แอบขโมยแผนที่ดาว/, pressed: false });
    expect(count(2)).toBeTruthy();
    expect(server.ratingCalls).toEqual([
      { method: 'PUT', path: '/api/game/rating/likes/3-NOCTHERION-1-1', body: undefined },
      { method: 'DELETE', path: '/api/game/rating/likes/3-NOCTHERION-1-1', body: undefined },
    ]);
  });

  it('GEN-078 C4: a game still playing has no rating form and no 👍', async () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-playing']));
    const server = stubServer();
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ดูสรุป เกมคืนวันศุกร์' }));
    await screen.findByRole('region', { name: 'สรุปเกม เกมคืนวันศุกร์' });
    expect(screen.queryByRole('region', { name: 'ให้คะแนนเกม' })).toBeNull();
    expect(screen.queryByLabelText('คะแนน 1–10')).toBeNull();
    expect(screen.queryByRole('button', { name: /👍/ })).toBeNull();
    expect(server.filter((c) => c.includes('/api/game/rating'))).toEqual([]);
  });

  it('a game still playing has no reveal section', async () => {
    localStorage.setItem(KNOWN_TOKENS_KEY, JSON.stringify(['tok-playing']));
    stubServer();
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ดูสรุป เกมคืนวันศุกร์' }));
    await screen.findByRole('region', { name: 'สรุปเกม เกมคืนวันศุกร์' });
    expect(screen.queryByRole('region', { name: 'ความลับของทุกคน' })).toBeNull();
  });

  it('says so when this browser has no game yet', async () => {
    stubServer();
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'รายการเกม' }));
    expect(await screen.findByText('ยังไม่มีเกมในเครื่องนี้ เข้าร่วมหรือสร้างเกมก่อน')).toBeTruthy();
  });
});
