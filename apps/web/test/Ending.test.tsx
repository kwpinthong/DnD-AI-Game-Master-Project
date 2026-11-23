// GEN-091: the end page (Screens and Flows v2 §6) on the GEN-099 fixtures. C2 secrets → rating form → 👍 on
// one page in the wireframe's order, C3 the form after sending + the learning status.
import { GameLogResponse, type GameRatingView } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLog } from '../src/GameHistory.tsx';
import { mockHttp } from '../src/mock/http.ts';
import { scenarioById } from '../src/mock/scenarios.ts';

const ENDED = GameLogResponse.parse(CONTRACT_FIXTURES.GameLogResponse[1]);
const RATED: GameRatingView = CONTRACT_FIXTURES.GameRatingResponse[0]!.rating;
const NOT_RATED: GameRatingView = CONTRACT_FIXTURES.GameRatingResponse[1]!.rating;
const REF = '2-HESPERION-1-7';

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

/** A rating server: GET gives `start`; PUT stores the score; a ruling vote sets / clears the ref (GEN-171). */
function ratingServer(start: GameRatingView | 'down', afterPut: Partial<GameRatingView> = {}) {
  let rating = start === 'down' ? NOT_RATED : start;
  const state = { down: start === 'down' };
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (state.down) throw new TypeError('Failed to fetch');
      if (path === '/api/game/rating' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { score: number; comment?: string };
        rating = { ...rating, mine: { score: body.score, comment: body.comment ?? '' }, raters: rating.raters + (rating.mine ? 0 : 1), ...afterPut };
      } else if (path.startsWith('/api/game/rating/votes/')) {
        const ref = decodeURIComponent(path.split('/').pop()!);
        const { vote } = JSON.parse(String(init?.body)) as { vote: 'up' | 'down' | null };
        const { [ref]: _gone, ...others } = rating.myVotes;
        rating = { ...rating, myVotes: vote ? { ...others, [ref]: vote } : others };
      } else if (path !== '/api/game/rating') {
        return Response.json({ code: 'not_found', message: 'ไม่พบ' }, { status: 404 });
      }
      return Response.json({ rating });
    }),
  );
  return { calls, state };
}

const openPage = () => render(<GameLog log={ENDED} apiBaseUrl="http://api" token="tok" onBack={() => {}} />);
const ratingRegion = () => within(screen.getByRole('region', { name: 'ให้คะแนนเกม' }));
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('GEN-091 end page', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('C2: ending, fates + secrets (karma as a word with the number in brackets), then the 1–10 form; 👍 sits on the secret row', async () => {
    const { calls } = ratingServer(NOT_RATED);
    openPage();
    const reveal = screen.getByRole('region', { name: 'ความลับของทุกคน' });
    const rating = screen.getByRole('region', { name: 'ให้คะแนนเกม' });
    expect(before(reveal, rating)).toBe(true);
    expect(before(within(reveal).getByRole('heading', { name: 'ฉากจบ' }), within(reveal).getByRole('heading', { name: 'ชะตาของแต่ละคน' }))).toBe(true);

    const lin = within(within(reveal).getByRole('article', { name: 'นก' }));
    expect(lin.getByText('ผู้มีจิตใจเอื้อเฟื้อ')).toBeTruthy();
    expect(lin.getByText('(24)').tagName).toBe('SMALL');
    expect(lin.getByText(/หญิงผ้าคลุมเทา/)).toBeTruthy();
    expect(lin.getByText('ผู้ใจบุญ')).toBeTruthy();
    expect(lin.getByText('ลินยืนดูแสงรุ่งอรุณคืนสู่เมือง')).toBeTruthy();
    // Q-270: the secrets are one list apart from the cards, not inside them
    expect(lin.queryByText(/แอบเข้าโบสถ์ชั้นใต้ดิน/)).toBeNull();
    const secrets = within(within(reveal).getByRole('list', { name: 'สิ่งที่ทำไว้ลับ ๆ' }));
    expect(secrets.getByText(/แอบเข้าโบสถ์ชั้นใต้ดิน/)).toBeTruthy();

    const scores = await ratingRegion().findAllByRole('radio');
    expect(scores.map((r) => (r as HTMLInputElement).value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/game/rating', auth: 'Bearer tok' });

    // GEN-171: the 👍/👎 set of GEN-107 on the action row, above the form; no totals anywhere
    const group = await secrets.findByRole('group', { name: /โหวตการตัดสินนี้: .*แอบเข้าโบสถ์ชั้นใต้ดิน/ });
    expect(before(group, rating)).toBe(true);
    const up = within(group).getByRole('button', { name: 'ถูกใจ' });
    const down = within(group).getByRole('button', { name: 'ไม่ถูกใจ' });
    expect([up.getAttribute('aria-pressed'), down.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
    expect(screen.queryByLabelText(/👍 \d+ คน/)).toBeNull();
    // C1: 👎
    fireEvent.click(down);
    await waitFor(() => expect(down.getAttribute('aria-pressed')).toBe('true'));
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: `/api/game/rating/votes/${REF}`, body: { vote: 'down' } });
    // C2: the other one switches
    fireEvent.click(up);
    await waitFor(() => expect(up.getAttribute('aria-pressed')).toBe('true'));
    expect(down.getAttribute('aria-pressed')).toBe('false');
    expect(calls.at(-1)).toMatchObject({ body: { vote: 'up' } });
    expect(ratingRegion().getByText(/คุณกดไป 1/)).toBeTruthy();
    // C3: the same one again cancels
    fireEvent.click(up);
    await waitFor(() => expect(up.getAttribute('aria-pressed')).toBe('false'));
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: `/api/game/rating/votes/${REF}`, body: { vote: null } });
  });

  it.each([
    ['ended-rated', 'true', 'false'],
    ['ended-down', 'false', 'true'],
    ['ended', 'false', 'false'],
  ])('GEN-171: mock scenario %s shows 👍 %s / 👎 %s', async (id, up, down) => {
    const rating = mockHttp(scenarioById(id), { method: 'GET', path: '/api/game/rating' }) as { body: { rating: GameRatingView } };
    ratingServer(rating.body.rating);
    openPage();
    const group = within(await screen.findByRole('group', { name: /โหวตการตัดสินนี้/ }));
    expect(group.getByRole('button', { name: 'ถูกใจ' }).getAttribute('aria-pressed')).toBe(up);
    expect(group.getByRole('button', { name: 'ไม่ถูกใจ' }).getAttribute('aria-pressed')).toBe(down);
  });

  it('GEN-171 C4: the Human GM (canVote false) gets no vote buttons', async () => {
    ratingServer(CONTRACT_FIXTURES.GameRatingResponse[3]!.rating);
    openPage();
    await ratingRegion().findByText('ส่งแล้ว · แก้ได้');
    expect(screen.queryByRole('group', { name: /โหวตการตัดสินนี้/ })).toBeNull();
  });

  it('Q-270: every secret is in one list in time order across players; the day filter narrows it', () => {
    ratingServer(NOT_RATED);
    const [lin] = ENDED.reveal!.players;
    const log = {
      ...ENDED,
      reveal: {
        ...ENDED.reveal!,
        players: [
          { ...lin!, secretActions: [{ day: 5, phase: 'SOLARION' as const, turn: 1, text: 'ลินทำทีหลัง' }, { day: 2, phase: 'NOCTHERION' as const, turn: 1, text: 'ลินทำคืนวันสอง' }] },
          { ...lin!, memberId: 'm-2', lobbyName: 'บี', characterName: 'ดาริน', secretActions: [{ day: 2, phase: 'EOSORIA' as const, turn: 2, text: 'ดารินทำเช้าวันสอง' }] },
        ],
      },
    };
    render(<GameLog log={log} apiBaseUrl="http://api" token="tok" onBack={() => {}} />);
    const list = () => within(screen.getByRole('list', { name: 'สิ่งที่ทำไว้ลับ ๆ' }));
    const texts = () => list().getAllByRole('listitem').map((li) => li.textContent!);
    expect(texts().map((t) => /ดารินทำเช้า|ลินทำคืน|ลินทำทีหลัง/.exec(t)![0])).toEqual(['ดารินทำเช้า', 'ลินทำคืน', 'ลินทำทีหลัง']);
    expect(texts()[0]).toContain('ดาริน (บี)');
    fireEvent.change(screen.getByLabelText('ดูวัน'), { target: { value: '2' } });
    expect(texts()).toHaveLength(2);
    expect(screen.queryByText(/ลินทำทีหลัง/)).toBeNull();
  });

  it('C3: after sending, the form becomes "ส่งแล้ว · แก้ได้" with the learning status; it can be opened again', async () => {
    const { calls } = ratingServer(NOT_RATED, { average: 8.6, raters: 3 });
    openPage();
    const r = ratingRegion();
    fireEvent.click(await r.findByRole('radio', { name: '9' }));
    fireEvent.change(r.getByLabelText(/ความเห็น/), { target: { value: 'สนุกมาก' } });
    fireEvent.click(r.getByRole('button', { name: 'ส่งคะแนน' }));

    expect(await r.findByText('ส่งแล้ว · แก้ได้')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/game/rating', body: { score: 9, comment: 'สนุกมาก' } });
    expect(r.queryByRole('radio')).toBeNull();
    expect(r.getByText(/คุณให้ 9\/10/)).toBeTruthy();
    expect(r.getByRole('status', { name: 'คะแนนเกม' }).textContent).toBe('คะแนนเกม 8.60 จาก 3 คน');

    fireEvent.click(r.getByRole('button', { name: 'แก้คะแนน' }));
    expect((r.getByRole('radio', { name: '9' }) as HTMLInputElement).checked).toBe(true);
    expect((r.getByLabelText(/ความเห็น/) as HTMLTextAreaElement).value).toBe('สนุกมาก');
  });

  it('C3: a game someone already rated opens as sent', async () => {
    ratingServer(RATED);
    openPage();
    expect(await ratingRegion().findByText('ส่งแล้ว · แก้ได้')).toBeTruthy();
    expect(ratingRegion().getByText(/คุณกดไป 1/)).toBeTruthy();
    const group = within(screen.getByRole('group', { name: /โหวตการตัดสินนี้/ }));
    expect(group.getByRole('button', { name: 'ถูกใจ' }).getAttribute('aria-pressed')).toBe('true');
  });

  it.each([
    // GEN-079 C14: the score is shown to 2 decimals with how many rated; it is no gate (no pass / fail line).
    [{ average: 8.5, raters: 2, members: 4 }, 'คะแนนเกม 8.50 จาก 2 คน'],
    [{ average: 4, raters: 4, members: 4 }, 'คะแนนเกม 4.00 จาก 4 คน'],
    [{ average: null, raters: 0, members: 4 }, 'ยังไม่มีคะแนน'],
  ])('GEN-079 C14: the game score %j', async (part, text) => {
    ratingServer({ ...NOT_RATED, ...part });
    openPage();
    const status = await ratingRegion().findByRole('status', { name: 'คะแนนเกม' });
    expect(status.textContent).toBe(text);
    expect(ratingRegion().queryByText(/เกณฑ์|รอคะแนนอีก/)).toBeNull();
  });

  it('asks for a score before sending, and shows the server message when it refuses', async () => {
    const { calls } = ratingServer(NOT_RATED);
    openPage();
    const r = ratingRegion();
    fireEvent.click(await r.findByRole('button', { name: 'ส่งคะแนน' }));
    expect(r.getByRole('alert').textContent).toBe('เลือกคะแนน 1–10');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('the rating could not be loaded: an error state with a retry, the secrets stay readable', async () => {
    const { state } = ratingServer('down');
    openPage();
    const r = ratingRegion();
    expect((await r.findByRole('alert')).textContent).toMatch(/โหลดคะแนนของเกมนี้ไม่ได้/);
    expect(screen.getByRole('article', { name: 'นก' })).toBeTruthy();
    // no 👍 without the rating
    expect(screen.queryByRole('group', { name: /โหวตการตัดสินนี้/ })).toBeNull();
    state.down = false;
    fireEvent.click(r.getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(await r.findAllByRole('radio')).toHaveLength(10);
  });

  it('Q-270: secrets over several days and players show a day filter; one day narrows the list, ทุกวัน restores it', () => {
    const reply = scenarioById('ended-days').http['GET /api/game/log'] as { body: unknown };
    ratingServer(NOT_RATED);
    render(<GameLog log={GameLogResponse.parse(reply.body)} apiBaseUrl="http://api" token="tok" onBack={() => {}} />);
    const list = () => within(screen.getByRole('list', { name: 'สิ่งที่ทำไว้ลับ ๆ' })).getAllByRole('listitem');
    expect(list()).toHaveLength(4);
    const filter = screen.getByRole('combobox', { name: 'ดูวัน' });
    expect([...(filter as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['ทุกวัน', 'วันที่ 1', 'วันที่ 2', 'วันที่ 3', 'วันที่ 4']);
    fireEvent.change(filter, { target: { value: '3' } });
    expect(list()).toHaveLength(1);
    expect(list()[0]!.textContent).toMatch(/ลอบตามนักบวช/);
    fireEvent.change(filter, { target: { value: '' } });
    expect(list()).toHaveLength(4);
  });

  it('a game still playing has no rating section and asks the server for none', async () => {
    const { calls } = ratingServer(NOT_RATED);
    render(<GameLog log={GameLogResponse.parse(CONTRACT_FIXTURES.GameLogResponse[0])} apiBaseUrl="http://api" token="tok" onBack={() => {}} />);
    expect(screen.queryByRole('region', { name: 'ให้คะแนนเกม' })).toBeNull();
    expect(calls).toEqual([]);
  });
});
