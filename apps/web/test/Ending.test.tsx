// GEN-091: the end page (Screens and Flows v2 §6) on the GEN-099 fixtures. C2 secrets → rating form → 👍 on
// one page in the wireframe's order, C3 the form after sending + the learning status.
import { GameLogResponse, type GameRatingView } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLog } from '../src/GameHistory.tsx';

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

/** A rating server: GET gives `start`; PUT stores the score; likes add / remove the ref. */
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
      } else if (path.startsWith('/api/game/rating/likes/')) {
        const ref = decodeURIComponent(path.split('/').pop()!);
        rating = { ...rating, liked: method === 'PUT' ? [...rating.liked, ref] : rating.liked.filter((r) => r !== ref) };
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
    expect(before(within(reveal).getByRole('heading', { name: 'ฉากจบ' }), within(reveal).getByRole('heading', { name: 'ชะตาและความลับของแต่ละคน' }))).toBe(true);

    const lin = within(within(reveal).getByRole('article', { name: 'นก' }));
    expect(lin.getByText('ผู้มีจิตใจเอื้อเฟื้อ')).toBeTruthy();
    expect(lin.getByText('(24)').tagName).toBe('SMALL');
    expect(lin.getByText(/หญิงผ้าคลุมเทา/)).toBeTruthy();
    expect(lin.getByText('ผู้ใจบุญ')).toBeTruthy();
    expect(lin.getByText('ลินยืนดูแสงรุ่งอรุณคืนสู่เมือง')).toBeTruthy();
    expect(lin.getByText(/แอบเข้าโบสถ์ชั้นใต้ดิน/)).toBeTruthy();

    const scores = await ratingRegion().findAllByRole('radio');
    expect(scores.map((r) => (r as HTMLInputElement).value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/game/rating', auth: 'Bearer tok' });

    // 👍 is a toggle on the action row, above the form
    const like = lin.getByRole('button', { name: /ชอบการตัดสินนี้.*แอบเข้าโบสถ์ชั้นใต้ดิน/ });
    expect(before(like, rating)).toBe(true);
    expect(like.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(like);
    await waitFor(() => expect(like.getAttribute('aria-pressed')).toBe('true'));
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: `/api/game/rating/likes/${REF}` });
    expect(ratingRegion().getByText(/คุณกดไป 1/)).toBeTruthy();
    fireEvent.click(like);
    await waitFor(() => expect(like.getAttribute('aria-pressed')).toBe('false'));
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/game/rating/likes/${REF}` });
  });

  it('C3: after sending, the form becomes "ส่งแล้ว · แก้ได้" with the learning status; it can be opened again', async () => {
    const { calls } = ratingServer(NOT_RATED, { average: 8.6, raters: 3, eligible: true, blocker: null });
    openPage();
    const r = ratingRegion();
    fireEvent.click(await r.findByRole('radio', { name: '9' }));
    fireEvent.change(r.getByLabelText(/ความเห็น/), { target: { value: 'สนุกมาก' } });
    fireEvent.click(r.getByRole('button', { name: 'ส่งคะแนน' }));

    expect(await r.findByText('ส่งแล้ว · แก้ได้')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/game/rating', body: { score: 9, comment: 'สนุกมาก' } });
    expect(r.queryByRole('radio')).toBeNull();
    expect(r.getByText(/คุณให้ 9\/10/)).toBeTruthy();
    const status = within(r.getByRole('status', { name: 'สถานะการเรียนรู้' }));
    expect(status.getByText(/^ผ่านเกณฑ์/)).toBeTruthy();
    expect(status.getByText(/8\.6 จาก 3\/4 คน/)).toBeTruthy();

    fireEvent.click(r.getByRole('button', { name: 'แก้คะแนน' }));
    expect((r.getByRole('radio', { name: '9' }) as HTMLInputElement).checked).toBe(true);
    expect((r.getByLabelText(/ความเห็น/) as HTMLTextAreaElement).value).toBe('สนุกมาก');
  });

  it('C3: a game someone already rated opens as sent', async () => {
    ratingServer(RATED);
    openPage();
    expect(await ratingRegion().findByText('ส่งแล้ว · แก้ได้')).toBeTruthy();
    expect(ratingRegion().getByText(/คุณกดไป 1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /ชอบการตัดสินนี้/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it.each([
    // Q-222: half the members, the Human GM counted. 4 members need 2 raters, 5 need 3.
    [{ raters: 1, members: 4, blocker: 'too_few_raters' as const }, /^รอคะแนนอีก 1 คน/],
    [{ raters: 1, members: 5, blocker: 'too_few_raters' as const }, /^รอคะแนนอีก 2 คน/],
    [{ raters: 3, members: 4, average: 7.5, blocker: 'score_too_low' as const }, /^ไม่ผ่านเกณฑ์/],
  ])('C3: learning status %j', async (part, text) => {
    ratingServer({ ...NOT_RATED, average: 8.2, eligible: false, ...part });
    openPage();
    const status = within(await ratingRegion().findByRole('status', { name: 'สถานะการเรียนรู้' }));
    expect(status.getByText(text)).toBeTruthy();
  });

  it('Q-222: the waiting line says the GM counts', async () => {
    ratingServer(NOT_RATED);
    openPage();
    const status = await ratingRegion().findByRole('status', { name: 'สถานะการเรียนรู้' });
    expect(status.textContent).toMatch(/ครึ่งหนึ่งของสมาชิก.*GM/);
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
    expect(screen.queryByRole('button', { name: /ชอบการตัดสินนี้/ })).toBeNull();
    state.down = false;
    fireEvent.click(r.getByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(await r.findAllByRole('radio')).toHaveLength(10);
  });

  it('a game still playing has no rating section and asks the server for none', async () => {
    const { calls } = ratingServer(NOT_RATED);
    render(<GameLog log={GameLogResponse.parse(CONTRACT_FIXTURES.GameLogResponse[0])} apiBaseUrl="http://api" token="tok" onBack={() => {}} />);
    expect(screen.queryByRole('region', { name: 'ให้คะแนนเกม' })).toBeNull();
    expect(calls).toEqual([]);
  });
});
