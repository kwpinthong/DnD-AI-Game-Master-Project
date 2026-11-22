import { karmaTitle } from '@isekai/rules';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { karmaTiersFrom } from '../src/assets/karma.ts';
import { AssetLoadError, DEFAULT_ASSETS_DIR, loadGameAssets } from '../src/assets/load.ts';
import { TAB_FILES } from '../src/assets/model.ts';
import { makeTempDir } from './helpers.ts';

// C1: karma -100..+100 shows as one of the sheet's adjectives (System_Rules "Karma Tiers"; the sheet wins).
describe('karma tiers from the System_Rules asset (GEN-067)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => ({ dir, cleanup } = makeTempDir()));
  afterEach(() => cleanup());

  const tiers = () => loadGameAssets().karmaTiers;

  it.each([
    [14, 'คนหัดทำดี'],
    [13, 'เป็นกลาง'],
    [0, 'เป็นกลางสุดๆ'],
    [-13, 'เป็นกลาง'],
    [-14, 'วายร้ายฝึกหัด'],
    [100, 'ดีสุดขั้ว / แสงสว่างแห่งรุ่งอรุณ'],
    [-100, 'ชั่วสุดขีด / หายนะเดินดิน'],
  ])('C1: karma %i is "%s"', (karma, title) => {
    expect(karmaTitle(karma, tiers())).toBe(title);
  });

  it('C1: 5 Good words, the Neutral word (with its own word at 0) and 5 Evil words: 11 steps', () => {
    const words = [...new Set(tiers().map((t) => t.title))];
    expect(words).toHaveLength(12); // 11 steps + "เป็นกลางสุดๆ" at exactly 0
    expect(tiers().filter((t) => t.min >= 14)).toHaveLength(5);
    expect(tiers().filter((t) => t.max <= -14)).toHaveLength(5);
    expect(karmaTitle(1, tiers())).toBe('เป็นกลาง');
    expect(karmaTitle(-1, tiers())).toBe('เป็นกลาง');
    expect(karmaTitle(30, tiers())).toBe('คนหัดทำดี');
    expect(karmaTitle(31, tiers())).toBe('ผู้มีจิตใจเอื้อเฟื้อ');
  });

  it('a sheet whose karma rows leave a gap stops start-up and names the file and the field', () => {
    const assetsDir = join(dir, 'assets');
    cpSync(DEFAULT_ASSETS_DIR, assetsDir, { recursive: true });
    const file = join(assetsDir, TAB_FILES.System_Rules);
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{ category: string; mechanics: string }>;
    const good = rows.find((r) => r.category === 'Karma Tiers' && r.mechanics.includes('คนหัดทำดี'))!;
    good.mechanics = good.mechanics.replace('+14..+30', '+15..+30');
    writeFileSync(file, JSON.stringify(rows));

    expect(() => loadGameAssets(assetsDir)).toThrow(AssetLoadError);
    expect(() => loadGameAssets(assetsDir)).toThrow(TAB_FILES.System_Rules);
    expect(() => loadGameAssets(assetsDir)).toThrow('mechanics');
  });

  it('no Karma Tiers rows at all is refused', () => {
    expect(karmaTiersFrom([])).toMatchObject({ ok: false });
  });
});
