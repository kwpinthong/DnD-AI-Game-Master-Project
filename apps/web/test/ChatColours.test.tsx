// GEN-142 C1: the dev page /dev/chat-colours (mock scenario `chat-colours`) shows, on one page, another player's
// action box (PlayerBubble), a gain badge and the vote buttons, so the colours can be compared with the mockup.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatColours } from '../src/dev/ChatColours.tsx';
import { scenarioById } from '../src/mock/scenarios.ts';

afterEach(cleanup);

describe('GEN-142 chat colours scenario', () => {
  it('C1 one page has a PlayerBubble, a gain badge and vote buttons', () => {
    expect(scenarioById('chat-colours').id).toBe('chat-colours');
    const { container } = render(<ChatColours />);
    expect(container.querySelector('.chat-box--player')).not.toBeNull();
    expect(container.querySelector('.chat-result--gain')).not.toBeNull();
    expect(screen.getAllByRole('group', { name: /ให้คะแนน|ถูกใจ/ }).length).toBeGreaterThan(0);
    expect(container.querySelector('.chat-box--own')).not.toBeNull();
    expect(container.querySelector('.chat-box--npc')).not.toBeNull();
  });
});
