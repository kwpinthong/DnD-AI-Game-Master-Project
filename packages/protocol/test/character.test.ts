import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_MAX_LENGTH,
  CHARACTER_NAME_MAX_LENGTH,
  CharacterRequest,
  characterFieldErrors,
  PERSONALITY_MAX_LENGTH,
} from '../src/index.ts';

const SARA_AM = 'ำ';
const NIKHAHIT_SARA_AA = 'ํา';

const valid = { name: 'ลิน', appearance: 'ผ้าคลุมเทา', personality: 'พูดน้อย' };

/** "คำ" is 2 code points in NFC and 3 once NFKC splits sara am. */
const kham = (count: number) => 'คำ'.repeat(count);

// GEN-094 (Q-108): character text is NFC like action text; NFKC split ำ into ํ + า.
describe('character text keeps sara am whole (GEN-094)', () => {
  it('C1: a name, appearance and personality with ำ come back as typed', () => {
    const parsed = CharacterRequest.parse({ name: ' คำแก้ว ', appearance: 'ผิวสีคล้ำ', personality: 'ทำอะไรช้า\nแต่จำแม่น' });

    expect(parsed).toEqual({ name: 'คำแก้ว', appearance: 'ผิวสีคล้ำ', personality: 'ทำอะไรช้า\nแต่จำแม่น' });
    expect(parsed.name).toContain(SARA_AM);
    expect(parsed.name).not.toContain(NIKHAHIT_SARA_AA);
  });

  it('C1: a decomposed name is still composed by NFC and inner spaces still fold', () => {
    expect(CharacterRequest.parse({ ...valid, name: 'คำ   แก้ว' }).name).toBe('คำ แก้ว');
    expect(CharacterRequest.parse({ ...valid, name: 'é' }).name).toBe('é');
  });

  it.each([
    ['name', CHARACTER_NAME_MAX_LENGTH],
    ['appearance', APPEARANCE_MAX_LENGTH],
    ['personality', PERSONALITY_MAX_LENGTH],
  ] as const)('C3: a %s of exactly %i code points with ำ passes, counted after NFC', (field, max) => {
    const atLimit = kham(max / 2);

    expect([...atLimit]).toHaveLength(max);
    expect(characterFieldErrors({ ...valid, [field]: atLimit })).toEqual({});
    expect(CharacterRequest.parse({ ...valid, [field]: atLimit })[field]).toBe(atLimit);
  });

  it.each([
    ['name', CHARACTER_NAME_MAX_LENGTH, `ชื่อจริงยาวได้ไม่เกิน ${CHARACTER_NAME_MAX_LENGTH} ตัวอักษร`],
    ['appearance', APPEARANCE_MAX_LENGTH, `ลักษณะภายนอกยาวได้ไม่เกิน ${APPEARANCE_MAX_LENGTH} ตัวอักษร`],
    ['personality', PERSONALITY_MAX_LENGTH, `บุคลิกยาวได้ไม่เกิน ${PERSONALITY_MAX_LENGTH} ตัวอักษร`],
  ] as const)('C4: a %s one code point over %i is refused', (field, max, message) => {
    expect(characterFieldErrors({ ...valid, [field]: `${kham(max / 2)}ก` })).toEqual({ [field]: message });
  });
});
