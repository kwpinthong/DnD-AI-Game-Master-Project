import { describe, expect, it } from 'vitest';
import {
  AppearanceOptions,
  APPEARANCE_CATEGORIES,
  AVATAR_IDS,
  composeAppearance,
  normalizeAppearanceExtra,
  type AppearanceLabels,
  type AppearanceTraits,
} from '../src/index.ts';

// ISK-006: the appearance sentence is built from chips (+ a short free text) by one function the server and web share.

const MAPS: Record<keyof AppearanceLabels, Record<string, string>> = {
  hairColor: { black: 'ดำ', brown: 'น้ำตาล', blond: 'ทอง', silver: 'เงิน', red: 'แดง', white: 'ขาว' },
  hairStyle: { short: 'สั้น', long: 'ยาว', ponytail: 'มัดหาง', braid: 'ถักเปีย', wavy: 'หยักศก', shaved: 'โกน' },
  eyes: { black: 'ดำ', brown: 'น้ำตาล', blue: 'ฟ้า', green: 'เขียว', gold: 'ทอง', heterochromia: 'สองสี' },
  build: { tall: 'ผอมสูง', average: 'สมส่วน', muscular: 'ล่ำสัน', small: 'ตัวเล็ก', stout: 'ท้วม' },
  outfit: { commoner: 'ชุดชาวบ้าน', traveler: 'ชุดเดินทาง', leather: 'เกราะหนัง', mage: 'เสื้อคลุมนักเวท', priest: 'ชุดนักบวช', noble: 'ชุดสูงศักดิ์' },
  feature: { none: 'ไม่มี', scar: 'แผลเป็นที่แก้ม', eyepatch: 'ผ้าปิดตา', tattoo: 'รอยสัก', glasses: 'แว่นตา', veil: 'ผ้าคลุมหน้า' },
};
/** The same shape as GET /api/appearance-options `categories`. */
const LABELS = Object.fromEntries(
  APPEARANCE_CATEGORIES.map((c) => [c, Object.entries(MAPS[c]).map(([id, label]) => ({ id, label }))]),
) as AppearanceLabels;

describe('composeAppearance (ISK-006)', () => {
  it('C1: long, black, blue, tall, traveler, scar', () => {
    const traits: AppearanceTraits = { hairColor: 'black', hairStyle: 'long', eyes: 'blue', build: 'tall', outfit: 'traveler', feature: 'scar' };
    expect(composeAppearance(traits, LABELS)).toBe('ผมยาวสีดำ ดวงตาสีฟ้า รูปร่างผอมสูง สวมชุดเดินทาง มีแผลเป็นที่แก้ม');
  });

  it('C2: shaved + heterochromia + no feature + extra, one space between parts', () => {
    const traits: AppearanceTraits = { hairColor: 'red', hairStyle: 'shaved', eyes: 'heterochromia', build: 'stout', outfit: 'priest', feature: 'none', extra: 'ถือไม้เท้าเก่า' };
    const out = composeAppearance(traits, LABELS);
    expect(out).toBe('ศีรษะโกนเกลี้ยง ดวงตาสองสี รูปร่างท้วม สวมชุดนักบวช ถือไม้เท้าเก่า');
    expect(out).not.toMatch(/\s{2}/);
  });

  it('C2: an empty extra adds nothing (no trailing space)', () => {
    const traits: AppearanceTraits = { hairColor: 'red', hairStyle: 'short', eyes: 'gold', build: 'small', outfit: 'noble', feature: 'none', extra: '' };
    expect(composeAppearance(traits, LABELS)).toBe('ผมสั้นสีแดง ดวงตาสีทอง รูปร่างตัวเล็ก สวมชุดสูงศักดิ์');
  });

  it('extra: trimmed, NFC, each line break (and run of spaces) one space, tags kept as text', () => {
    expect(normalizeAppearanceExtra('  ถือ\nไม้เท้า \r\n  เก่า  ')).toBe('ถือ ไม้เท้า เก่า');
    expect(normalizeAppearanceExtra('<b>คำ</b>')).toBe('<b>คำ</b>');
    expect(normalizeAppearanceExtra('กํา')).toBe('กำ'.normalize('NFC'));
  });
});

describe('appearance-options data set schema (ISK-006)', () => {
  const seed = () =>
    APPEARANCE_CATEGORIES.flatMap((category) => LABELS[category].map(({ id, label }) => ({ category, id, label })));

  it('accepts the default list, a hidden value and a new value', () => {
    expect(AppearanceOptions.safeParse(seed()).success).toBe(true);
    const edited = [...seed().map((o) => (o.id === 'mage' ? { ...o, hidden: true } : o)), { category: 'outfit' as const, id: 'ranger', label: 'ชุดพราน' }];
    expect(AppearanceOptions.safeParse(edited).success).toBe(true);
  });

  it('refuses a repeated id in one category, an empty label and a category with no visible value', () => {
    expect(AppearanceOptions.safeParse([...seed(), { category: 'eyes', id: 'blue', label: 'น้ำเงิน' }]).success).toBe(false);
    expect(AppearanceOptions.safeParse(seed().map((o) => (o.id === 'tall' ? { ...o, label: ' ' } : o))).success).toBe(false);
    expect(AppearanceOptions.safeParse(seed().map((o) => (o.category === 'build' ? { ...o, hidden: true } : o))).success).toBe(false);
    expect(AppearanceOptions.safeParse(seed().filter((o) => o.category !== 'feature')).success).toBe(false);
  });
});

describe('avatar ids (ISK-005 presets)', () => {
  it('C5: avatar-01..12 only', () => {
    expect(AVATAR_IDS).toEqual(Array.from({ length: 12 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`));
  });
});
