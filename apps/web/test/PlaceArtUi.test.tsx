// GEN-132: avatar rings (C4), the clock and the weather painting (C5), the painted assets in the CSS (C6, C7 part).
import type { RoomState } from '@isekai/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NpcBubble, PlayerBubble } from '../src/play/chat/Bubbles.tsx';
import { ClockHud } from '../src/play/chat/ClockHud.tsx';
import { CharacterTag } from '../src/play/chat/Hud.tsx';
import { RING_ART, ringFor } from '../src/play/ring-art.ts';
import { weatherArt } from '../src/play/weather-art.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, '..', 'src', file), 'utf8').replace(/\r\n/g, '\n');
afterEach(cleanup);

const ringOf = (el: Element | null) => el?.querySelector('.chat-avatar')?.getAttribute('data-ring');

describe('C4 the ring follows the grade the payload gave, never one it did not', () => {
  it('F B A S SS -> their own ring file; no grade -> the neutral B ring; our own -> player', () => {
    for (const g of ['F', 'B', 'A', 'S', 'SS'] as const) {
      expect(ringFor({ grade: g })).toBe(g.toLowerCase());
      expect(RING_ART[ringFor({ grade: g })]).toContain(`avatar-ring-${g.toLowerCase()}`);
    }
    expect(ringFor({})).toBe('b');
    expect(ringFor({ own: true })).toBe('player');
    expect(RING_ART.player).toContain('avatar-ring-player');
  });

  it.each(['F', 'B', 'A', 'S', 'SS'] as const)('an NPC line with grade %s wears that ring and keeps its first letter', (g) => {
    const { container } = render(<NpcBubble name="ลูเซีย" grade={g} text="สวัสดี" />);
    expect(ringOf(container)).toBe(g.toLowerCase());
    expect(container.querySelector('.chat-avatar')?.textContent).toBe('ล');
    expect(container.querySelector('.chat-avatar__ring')?.getAttribute('src')).toContain(`avatar-ring-${g.toLowerCase()}`);
  });

  it('an NPC whose grade is not sent gets the neutral ring (no grade is revealed)', () => {
    const { container } = render(<NpcBubble name="หญิงชุดเทา" text="..." />);
    expect(ringOf(container)).toBe('b');
  });

  it('another player is B, our own character is player', () => {
    const other = render(<PlayerBubble alias="นักดนตรี" text="..." />);
    expect(ringOf(other.container)).toBe('b');
    cleanup();
    const mine = render(<CharacterTag character={{ name: 'ฉัน', appearance: 'ผู้กล้า' }} />);
    expect(ringOf(mine.container)).toBe('player');
  });
});

describe('C5 weather painting and the clock', () => {
  it('maps the room weather to its file with the alt in words; unknown weather has no image', () => {
    const at = (weather: string, disaster = false) => weatherArt({ weather, disaster } as never);
    expect([at('Clear'), at('Rain'), at('Fog'), at('Dark Night')].map((a) => a?.alt)).toEqual(['แดดจ้า', 'ฝนตก', 'หมอกจัด', 'คืนเดือนมืด']);
    expect(at('Clear')?.src).toContain('weather-clear');
    expect(at('Rain')?.src).toContain('weather-rain');
    expect(at('Fog')?.src).toContain('weather-fog');
    expect(at('Dark Night')?.src).toContain('weather-dark-night');
    expect(at('Rain', true)).toMatchObject({ alt: 'ภัยพิบัติ' });
    expect(at('Rain', true)?.src).toContain('weather-disaster');
    expect(at('Storm')).toBeNull();
    expect(at('Clear Night')).toBeNull();
    expect(at('Meteor')).toBeNull();
    expect(weatherArt(null)).toBeNull();
  });

  const roomAt = (phase: string, weather: unknown) => ({ day: 2, phase, turn: 1, weather, mode: 'single', submittedCount: 0, members: [] }) as unknown as RoomState;
  it.each([
    ['EOSORIA', 'เช้า', -67.5],
    ['SOLARION', 'บ่าย', -22.5],
    ['HESPERION', 'ค่ำ', 22.5],
    ['NOCTHERION', 'ดึก', 67.5],
  ] as const)('%s: the hand points at its slot, the words and the weather image are there', (phase, word, angle) => {
    render(<ClockHud room={roomAt(phase, { weather: 'Rain', disaster: false })} />);
    const clock = screen.getByRole('group', { name: 'เวลาและสถานะเกม' });
    expect(within(clock).getByText(`${word} · เทิร์น 1/2`)).toBeTruthy();
    const hand = within(clock).getByRole('img', { name: new RegExp(`ช่วง${word}`) });
    expect(hand.querySelector('.clock__turn')?.getAttribute('style')).toContain(`rotate(${angle}deg)`);
    expect(within(clock).getByRole('img', { name: 'ฝนตก' }).getAttribute('src')).toContain('weather-rain');
    expect(clock.querySelector('.hud-time__weather')?.textContent).toContain('ฝนตก');
  });

  it('a weather without a painting leaves the word and no image', () => {
    render(<ClockHud room={roomAt('SOLARION', { weather: 'Storm', disaster: false })} />);
    expect(screen.queryByRole('img', { name: 'พายุ' })).toBeNull();
    expect(screen.getByText('พายุ')).toBeTruthy();
  });
});

describe('C6/C7 the painted assets are wired through Vite, with no hard colour', () => {
  const art = read('play/chat/art.css');
  it('texture, panel frame and primary button are CSS url()s of the assets folder (hashed by Vite)', () => {
    expect(art).toMatch(/texture-stars\.webp/);
    expect(art).toMatch(/border-image:\s*url\([^)]*frame-panel\.webp['"]?\)\s*70\s+fill\s*\/\s*26px\s+stretch/);
    expect(art).toMatch(/btn-primary\.webp/);
    expect(art).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(art).not.toMatch(/assets\/place\//);
  });

  it('no source file points at assets/place/ or at a .png of the assets folder', () => {
    for (const file of ['play/place-art.ts', 'play/weather-art.ts', 'play/ring-art.ts', 'play/chat/ClockHud.tsx', 'play/chat/PlaceArt.tsx', 'JoinForm.tsx', 'home-art.css']) {
      expect(read(file), file).not.toMatch(/assets\/place\/|\.png/);
    }
  });

  it('the home page uses home-keyart.webp', () => {
    expect(read('JoinForm.tsx')).toContain('illustrations/home-keyart.webp');
  });
});
