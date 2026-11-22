// GEN-107: the reusable 👍 / 👎 pair under an AI-written message. GEN-122 places it; this checks the button itself.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoteButtons } from '../src/ui/index.ts';

afterEach(cleanup);

const up = () => screen.getByRole('button', { name: 'ถูกใจ' });
const down = () => screen.getByRole('button', { name: 'ไม่ถูกใจ' });

describe('VoteButtons', () => {
  it('shows the words ถูกใจ / ไม่ถูกใจ as text, not only an icon', () => {
    render(<VoteButtons value={null} onVote={() => {}} />);
    expect(up().textContent).toContain('ถูกใจ');
    expect(down().textContent).toContain('ไม่ถูกใจ');
  });

  it.each([
    [null, 'false', 'false'],
    ['up', 'true', 'false'],
    ['down', 'false', 'true'],
  ] as const)('value %s: aria-pressed up=%s down=%s', (value, pressedUp, pressedDown) => {
    render(<VoteButtons value={value} onVote={() => {}} />);
    expect(up().getAttribute('aria-pressed')).toBe(pressedUp);
    expect(down().getAttribute('aria-pressed')).toBe(pressedDown);
  });

  it('C1: pressing ถูกใจ with no vote asks for up', () => {
    const onVote = vi.fn();
    render(<VoteButtons value={null} onVote={onVote} />);
    fireEvent.click(up());
    expect(onVote).toHaveBeenCalledWith('up');
  });

  it('C2: pressing the pressed one again asks to cancel (null)', () => {
    const onVote = vi.fn();
    render(<VoteButtons value="up" onVote={onVote} />);
    fireEvent.click(up());
    expect(onVote).toHaveBeenCalledWith(null);
  });

  it('C3: pressing the other one changes the vote', () => {
    const onVote = vi.fn();
    render(<VoteButtons value="up" onVote={onVote} />);
    fireEvent.click(down());
    expect(onVote).toHaveBeenCalledWith('down');
  });

  it('disabled (a request is running) presses nothing', () => {
    const onVote = vi.fn();
    render(<VoteButtons value={null} onVote={onVote} disabled />);
    fireEvent.click(up());
    expect(onVote).not.toHaveBeenCalled();
  });

  it('the group is named, and the styles use tokens only with a 44px tap target', () => {
    render(<VoteButtons value={null} onVote={() => {}} />);
    expect(screen.getByRole('group', { name: /AI GM/ })).toBeDefined();
    const css = readFileSync(join(__dirname, '../src/theme.css'), 'utf8');
    const block = css.slice(css.indexOf('/* ---------- Vote buttons'), css.indexOf('/* ---------- Form fields'));
    expect(block).toContain('min-height: 44px');
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
