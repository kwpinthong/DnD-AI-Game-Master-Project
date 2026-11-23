import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ISK-005: preset avatars shared by server and web; chip ids come from ISK-006.
const presets = JSON.parse(
  readFileSync(new URL('../src/avatar-presets.json', import.meta.url), 'utf8'),
) as Array<Record<string, string>>;
const avatarDir = new URL('../../../apps/web/src/assets/avatars/', import.meta.url);

const CHIPS: Record<string, string[]> = {
  hairColor: ['black', 'brown', 'blond', 'silver', 'red', 'white'],
  hairStyle: ['short', 'long', 'ponytail', 'braid', 'wavy', 'shaved'],
  eyes: ['black', 'brown', 'blue', 'green', 'gold', 'heterochromia'],
  build: ['tall', 'average', 'muscular', 'small', 'stout'],
  outfit: ['commoner', 'traveler', 'leather', 'mage', 'priest', 'noble'],
  feature: ['none', 'scar', 'eyepatch', 'tattoo', 'glasses', 'veil'],
};

// Lossy WebP ('VP8 ' chunk): 14-bit width/height at byte 26/28 of the file.
function webpSize(buf: Buffer): { width: number; height: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 16)).toBe('WEBPVP8 ');
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
}

const count = (key: string, value: string) => presets.filter((p) => p[key] === value).length;

describe('avatar presets (ISK-005)', () => {
  it('C1: avatar-01..12 exist as square 256px and @2x 512px webp', () => {
    expect(presets.map((p) => p.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`),
    );
    for (const { id } of presets) {
      for (const [suffix, px] of [['', 256], ['@2x', 512]] as const) {
        const file = new URL(`${id}${suffix}.webp`, avatarDir);
        expect(existsSync(file), `${id}${suffix}.webp`).toBe(true);
        expect(webpSize(readFileSync(file))).toEqual({ width: px, height: px });
      }
    }
  });

  it('C3: male >= 5, female >= 5, 3 skin tones, 3 age bands', () => {
    expect(count('sex', 'male')).toBeGreaterThanOrEqual(5);
    expect(count('sex', 'female')).toBeGreaterThanOrEqual(5);
    for (const tone of ['light', 'medium', 'dark']) expect(count('skinTone', tone)).toBeGreaterThan(0);
    for (const age of ['teen', 'adult', 'middle']) expect(count('ageBand', age)).toBeGreaterThan(0);
    for (const p of presets) {
      expect(['male', 'female']).toContain(p.sex);
      expect(['light', 'medium', 'dark']).toContain(p.skinTone);
      expect(['teen', 'adult', 'middle']).toContain(p.ageBand);
    }
  });

  it('C3: every preset has an alt and real ISK-006 chip value ids', () => {
    for (const p of presets) {
      expect(p.alt?.trim().length, `${p.id} alt`).toBeGreaterThan(0);
      for (const [key, values] of Object.entries(CHIPS)) expect(values, `${p.id}.${key}`).toContain(p[key]);
    }
  });
});
