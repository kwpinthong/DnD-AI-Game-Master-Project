import { describe, expect, it } from 'vitest';
import { AdminFeedbackStatusRequest, FeedbackInput, FeedbackRow } from '../src/index.ts';

/** ISK-010: the contract of a player's report (input) and the stored row the admin reads. */
describe('ISK-010 FeedbackInput', () => {
  const ok = { type: 'bug', text: 'ปุ่มส่งค้าง', page: 'play' };
  const pathOf = (body: unknown) => FeedbackInput.safeParse(body).error?.issues.map((i) => String(i.path[0]));

  it('trims the text and keeps it as sent (no escaping, no NFC change)', () => {
    expect(FeedbackInput.parse({ ...ok, text: '  <b>ค้าง</b>  ' })).toEqual({ type: 'bug', text: '<b>ค้าง</b>', page: 'play' });
  });

  it('text: 1..1000 code points after trim', () => {
    expect(pathOf({ ...ok, text: '   ' })).toEqual(['text']);
    expect(pathOf({ ...ok, text: undefined })).toEqual(['text']);
    // 1000 emoji = 2000 UTF-16 units but 1000 code points.
    expect(FeedbackInput.safeParse({ ...ok, text: '😀'.repeat(1000) }).success).toBe(true);
    expect(pathOf({ ...ok, text: '😀'.repeat(1001) })).toEqual(['text']);
  });

  it('type and page must be in their lists', () => {
    expect(pathOf({ ...ok, type: 'spam' })).toEqual(['type']);
    expect(pathOf({ ...ok, page: 'x' })).toEqual(['page']);
    for (const page of ['lobby', 'character', 'loot', 'spawn', 'play', 'ending', 'other']) expect(FeedbackInput.safeParse({ ...ok, page }).success).toBe(true);
  });

  it('cuts userAgent at 300 and drops fields it does not know (day, gameId)', () => {
    const parsed = FeedbackInput.parse({ ...ok, userAgent: 'a'.repeat(400), day: 99, gameId: 'g-x' });
    expect(parsed.userAgent).toBe('a'.repeat(300));
    expect(parsed).not.toHaveProperty('day');
    expect(parsed).not.toHaveProperty('gameId');
  });

  it('status request accepts only new / reviewing / done', () => {
    expect(AdminFeedbackStatusRequest.safeParse({ status: 'done' }).success).toBe(true);
    expect(AdminFeedbackStatusRequest.safeParse({ status: 'closed' }).success).toBe(false);
  });
});

describe('ISK-010 FeedbackRow', () => {
  const row = {
    id: 1,
    gameId: 'g',
    memberId: 'm',
    type: 'idea',
    text: 'x',
    context: { day: null, period: null, turn: null, page: 'lobby', userAgent: '' },
    status: 'new',
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  };

  it('allows a lobby report with no day / period / turn, and a real period', () => {
    expect(FeedbackRow.safeParse(row).success).toBe(true);
    expect(FeedbackRow.safeParse({ ...row, context: { ...row.context, day: 3, period: 'SOLARION', turn: 2, page: 'play' } }).success).toBe(true);
  });

  it('is strict: an unknown period, status or extra field fails', () => {
    expect(FeedbackRow.safeParse({ ...row, context: { ...row.context, period: 'NOON' } }).success).toBe(false);
    expect(FeedbackRow.safeParse({ ...row, status: 'closed' }).success).toBe(false);
    expect(FeedbackRow.safeParse({ ...row, karma: 1 }).success).toBe(false);
  });
});
