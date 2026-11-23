// GEN-122: the pure rules of the chat-style Play page, and the vote hook (C2, C3, C9).
import type { RoomEntry } from '@isekai/protocol';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { changeBadges, dialAngle, dialLabel, dividerText, entryLook, prefillAction, rollBadge } from '../src/play/chat/chat-model.ts';
import { useEntryVotes } from '../src/play/chat/useEntryVotes.ts';

describe('C2 the dial', () => {
  it('the hand points at the middle of the slot of each period, left to right', () => {
    expect((['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const).map(dialAngle)).toEqual([-67.5, -22.5, 22.5, 67.5]);
  });

  it('the label reads day of 12, period, turn and weather', () => {
    const base = { day: 2, phase: 'SOLARION', turn: 1, weather: { weather: 'Rain', disaster: false } } as const;
    expect(dialLabel(base)).toBe('วันที่ 2 จาก 12 ช่วงบ่าย เทิร์น 1 จาก 2 อากาศฝนตก');
    expect(dialLabel({ ...base, phase: 'EOSORIA' })).toContain('ช่วงเช้า');
    expect(dialLabel({ ...base, phase: 'HESPERION' })).toContain('ช่วงค่ำ');
    expect(dialLabel({ ...base, phase: 'NOCTHERION', weather: null })).toContain('ช่วงดึก');
  });
});

describe('C3 quick words only prefill', () => {
  it('an empty box gets the word; a typed text keeps its words behind it', () => {
    expect(prefillAction('', 'สังเกต')).toBe('สังเกต');
    expect(prefillAction('', 'พูดคุย')).toBe('พูดคุย ');
    expect(prefillAction('ประตูบานนั้น', 'สังเกต')).toBe('สังเกต ประตูบานนั้น');
  });

  it('another quick word replaces the first one instead of stacking', () => {
    expect(prefillAction('สังเกต ประตูบานนั้น', 'สืบค้น')).toBe('สืบค้น ประตูบานนั้น');
    expect(prefillAction('พูดคุย โนอา', 'โจมตี')).toBe('โจมตี โนอา');
  });
});

describe('entries as chat', () => {
  it('names the look of each kind', () => {
    const look = (e: Partial<RoomEntry>, acked = false) => entryLook({ kind: 'feed', ...e }, acked);
    expect(look({})).toBe('narration');
    expect(look({ kind: 'narration' })).toBe('narration');
    expect(look({ kind: 'npc', npc: { ref: 'a', name: 'x', kind: 'dialogue' } })).toBe('npc-dialogue');
    expect(look({ kind: 'npc', npc: { ref: 'a', name: 'x', kind: 'reaction' } })).toBe('npc-reaction');
    expect(look({ kind: 'changes' })).toBe('changes');
    expect(look({ kind: 'hit' })).toBe('skip');
    expect(look({ kind: 'hit' }, true)).toBe('hit-line');
    expect(look({ kind: 'whisper' })).toBe('skip');
    // GEN-129: another player's public action is the left PlayerBubble; without its actor it is plain text.
    expect(look({ kind: 'player', actor: { name: 'ชายผมแดง' } })).toBe('player-action');
    expect(look({ kind: 'player' })).toBe('narration');
  });

  it('badges: the roll, each change with its reason, coins gained in the gain tone', () => {
    expect(rollBadge({ d20: 14, difficulty: 'ยาก', outcome: 'success', factors: [] })).toBe('ทอย 14 · สำเร็จ');
    expect(
      changeBadges([
        { stat: 'stamina', delta: -1, reason: 'เล่นดนตรี' },
        { stat: 'coins', delta: 1, reason: 'ได้ทิป' },
        { stat: 'coins', delta: -5, reason: 'ค่าที่พัก' },
        { stat: 'item_lost', name: 'ถุงเงิน', reason: 'ถูกขโมย' },
      ]),
    ).toEqual([
      { text: 'แรง −1 · เล่นดนตรี', tone: 'plain' },
      { text: 'เหรียญ +1 · ได้ทิป', tone: 'gain' },
      { text: 'เหรียญ −5 · ค่าที่พัก', tone: 'plain' },
      { text: 'ของหาย: ถุงเงิน · ถูกขโมย', tone: 'plain' },
    ]);
  });

  it('the divider names period, turn and place, and the day only when it is not today', () => {
    const at = { day: 2, phase: 'SOLARION', turn: 1, place: { id: 'fountain', name: 'น้ำพุกลางเมือง' } } as const;
    expect(dividerText(at, 2)).toBe('— บ่าย · เทิร์น 1 · น้ำพุกลางเมือง —');
    expect(dividerText({ ...at, day: 1 }, 2)).toBe('— วันที่ 1 · บ่าย · เทิร์น 1 · น้ำพุกลางเมือง —');
    expect(dividerText({ ...at, place: null }, 2)).toBe('— บ่าย · เทิร์น 1 —');
  });
});

describe('C9 useEntryVotes', () => {
  const entry = { seq: 10, myVote: null } as const;

  it('shows the press at once, keeps the answer, and a refusal puts the old vote back', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok: true, myVote: 'up' }).mockResolvedValueOnce({ ok: false, message: 'ให้คะแนนไม่สำเร็จ ลองใหม่อีกครั้ง' });
    const { result } = renderHook(() => useEntryVotes('', 't', send));
    await act(() => result.current.vote(entry, 'up'));
    expect(result.current.local.get(10)).toBe('up');
    expect(send).toHaveBeenCalledWith(10, 'up');
    await act(() => result.current.vote(entry, 'down'));
    expect(result.current.local.get(10)).toBe('up');
    expect(result.current.problem).toBe('ให้คะแนนไม่สำเร็จ ลองใหม่อีกครั้ง');
  });

  it('is optimistic while the request runs', async () => {
    let finish: (r: { ok: true; myVote: 'down' }) => void = () => {};
    const send = vi.fn(() => new Promise<{ ok: true; myVote: 'down' }>((r) => (finish = r)));
    const { result } = renderHook(() => useEntryVotes('', 't', send));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.vote({ seq: 12, myVote: 'up' }, 'down');
    });
    expect(result.current.local.get(12)).toBe('down');
    expect(result.current.busy.has(12)).toBe(true);
    await act(async () => {
      finish({ ok: true, myVote: 'down' });
      await pending;
    });
    expect(result.current.busy.has(12)).toBe(false);
  });
});
