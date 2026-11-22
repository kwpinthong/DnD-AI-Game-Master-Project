// GEN-132: painted place images by time of day. C1 (id x phase -> file), C2 (phase change), C3 (no art -> empty frame).
// The module is imported inside each test so a missing one fails that test by name, not the whole file.
import type { RoomState } from '@isekai/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayData } from '../src/play/play-api.ts';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const PLACES = ['inn', 'fountain', 'temple', 'forest', 'farmland', 'theater', 'manor', 'market', 'barracks', 'sea', 'dawn-church', 'clinic', 'library'];
const PHASES = ['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION'] as const;

// a glob (not a literal import) so a file that does not exist yet fails its tests, not the whole run
const mods = import.meta.glob(['../src/play/place-art.ts', '../src/play/chat/InfoPanel.tsx']);
const load = async <T,>(path: string): Promise<T> => {
  const loader = mods[path];
  if (!loader) throw new Error(`missing module ${path}`);
  return (await loader()) as T;
};
const artModule = () => load<typeof import('../src/play/place-art.ts')>('../src/play/place-art.ts');
const panelModule = () => load<typeof import('../src/play/chat/InfoPanel.tsx')>('../src/play/chat/InfoPanel.tsx');

const data: PlayData = { character: undefined, people: [], npcs: [], seenBy: 0, companions: null, inventory: undefined };
const roomAt = (placeId: string, phase: string, name = 'สถานที่ทดสอบ') => ({ phase, you: { place: { id: placeId, name }, allies: [], lock: null } }) as unknown as RoomState;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('C1 13 places x 4 phases -> the file of that place and period', () => {
  it('the table holds exactly the 52 files of illustrations/, no wrong names', async () => {
    const { PLACE_ART_TABLE } = await artModule();
    const files = readdirSync(join(src, 'assets', 'illustrations'))
      .filter((f) => f.startsWith('place-') && f.endsWith('.webp'))
      .map((f) => f.replace(/^place-/, '').replace(/\.webp$/, ''))
      .sort();
    const expected = PLACES.flatMap((p) => PHASES.map((ph) => `${p}-${ph.toLowerCase()}`)).sort();
    expect(files).toEqual(expected);
    expect(Object.keys(PLACE_ART_TABLE).sort()).toEqual(expected);
  });

  it('placeArt(id, phase) is the URL of place-<id>-<phase>.webp for all 52', async () => {
    const { placeArt } = await artModule();
    for (const id of PLACES) for (const ph of PHASES) expect(placeArt(id, ph), `${id} ${ph}`).toContain(`place-${id}-${ph.toLowerCase()}`);
  });

  it('the สถานที่ tab shows that image and its alt is the place name', async () => {
    const { PlacePanel } = await panelModule();
    render(<PlacePanel room={roomAt('market', 'HESPERION', 'ตลาดกลางเมือง')} data={data} onTravel={null} onSave={null} />);
    const img = screen.getByRole('img', { name: /ตลาดกลางเมือง/ });
    expect(img.getAttribute('src')).toContain('place-market-hesperion');
    expect(img.getAttribute('loading')).toBe('lazy');
  });
});

describe('C2 the room changes period -> the image changes, no reload', () => {
  it('SOLARION -> HESPERION swaps to the hesperion file', async () => {
    const { PlacePanel } = await panelModule();
    const { rerender } = render(<PlacePanel room={roomAt('fountain', 'SOLARION', 'น้ำพุ')} data={data} onTravel={null} onSave={null} />);
    expect(screen.getByRole('img', { name: /น้ำพุ/ }).getAttribute('src')).toContain('place-fountain-solarion');
    rerender(<PlacePanel room={roomAt('fountain', 'HESPERION', 'น้ำพุ')} data={data} onTravel={null} onSave={null} />);
    expect(screen.getByRole('img', { name: /น้ำพุ/ }).getAttribute('src')).toContain('place-fountain-hesperion');
  });

  it('the stylesheet turns the fade off under prefers-reduced-motion', () => {
    const css = readFileSync(join(src, 'play', 'chat', 'art.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*animation:\s*none/);
  });
});

describe('C3 no art for the place, or an unknown period -> an empty frame with the name', () => {
  it.each(['church-crypt', 'community', 'astral-rift', 'no-such-place'])('%s: no <img>, the name is shown, no console error', async (id) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PlacePanel } = await panelModule();
    const { container } = render(<PlacePanel room={roomAt(id, 'SOLARION', 'ที่ลึกลับ')} data={data} onTravel={null} onSave={null} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.place-art')?.textContent).toContain('ที่ลึกลับ');
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('an unknown period of a known place: empty frame + name', async () => {
    const { placeArt } = await artModule();
    expect(placeArt('inn', 'MIDNIGHT')).toBeNull();
    expect(placeArt('inn', undefined)).toBeNull();
    expect(placeArt('nowhere', 'EOSORIA')).toBeNull();
    const { PlacePanel } = await panelModule();
    const { container } = render(<PlacePanel room={roomAt('inn', 'MIDNIGHT', 'โรงเตี๊ยม')} data={data} onTravel={null} onSave={null} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.place-art')?.textContent).toContain('โรงเตี๊ยม');
  });
});
