// GEN-168 C1 / C2: after 👎 the player may pick reason chips (optional, several); 👍 or cancel clears them.
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEntryVotes } from '../src/play/chat/useEntryVotes.ts';
import { VoteButtons } from '../src/ui/VoteButtons.tsx';

afterEach(cleanup);

describe('GEN-168 reason chips', () => {
  it('C1: only after 👎, five chips, each a toggle; picking one reports the whole set', () => {
    const onReasons = vi.fn();
    const { rerender } = render(<VoteButtons value="up" onVote={() => {}} reasons={[]} onReasons={onReasons} />);
    expect(screen.queryByRole('group', { name: /เหตุผล/ })).toBeNull();
    rerender(<VoteButtons value="down" onVote={() => {}} reasons={['too_long']} onReasons={onReasons} />);
    const chips = within(screen.getByRole('group', { name: /เหตุผล/ }));
    expect(chips.getAllByRole('button').map((b) => b.textContent)).toEqual(['สำนวนแปล', 'ไม่ใช่นิสัยตัวนี้', 'ยาวไป', 'ผิดเรื่อง', 'อื่น ๆ']);
    expect(chips.getByRole('button', { name: 'ยาวไป' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chips.getByRole('button', { name: 'สำนวนแปล' }));
    expect(onReasons).toHaveBeenLastCalledWith(['too_long', 'translation']);
    fireEvent.click(chips.getByRole('button', { name: 'ยาวไป' }));
    expect(onReasons).toHaveBeenLastCalledWith([]);
  });

  it('C1 / C2: 👎 is sent at once with no reasons; a chip sends 👎 + reasons; 👍 clears them', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, myVote: 'down', myReasons: [] })
      .mockResolvedValueOnce({ ok: true, myVote: 'down', myReasons: ['wrong_story'] })
      .mockResolvedValueOnce({ ok: true, myVote: 'up' });
    const { result } = renderHook(() => useEntryVotes('', 't', send));
    const entry = { seq: 7, myVote: null } as const;
    await act(() => result.current.vote(entry, 'down'));
    expect(send).toHaveBeenLastCalledWith(7, 'down');
    await act(() => result.current.setReasons(entry, ['wrong_story']));
    expect(send).toHaveBeenLastCalledWith(7, 'down', ['wrong_story']);
    expect(result.current.reasons.get(7)).toEqual(['wrong_story']);
    await act(() => result.current.vote(entry, 'up'));
    expect(result.current.reasons.get(7)).toEqual([]);
  });
});
