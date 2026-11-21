import { describe, expect, it } from 'vitest';
import { joinFieldErrors, JoinRequest, nameKey, normalizeInviteCode } from '../src/index.ts';

const valid = { inviteCode: 'K7Q2MX', name: 'นก', pin: '1234' };

describe('JoinRequest', () => {
  it('accepts a 4 to 6 digit PIN and a name of up to 32 characters', () => {
    expect(JoinRequest.safeParse(valid).success).toBe(true);
    expect(JoinRequest.safeParse({ ...valid, pin: '000000' }).success).toBe(true);
    expect(JoinRequest.safeParse({ ...valid, name: 'ก'.repeat(32) }).success).toBe(true);
  });

  // C6: PIN 3 digits, 7 digits, with letters, empty name, name over 32 -> rejected, naming the field.
  it.each([
    ['PIN of 3 digits', { pin: '123' }, 'pin'],
    ['PIN of 7 digits', { pin: '1234567' }, 'pin'],
    ['PIN with a letter', { pin: '12a4' }, 'pin'],
    ['PIN with Thai digits', { pin: '๑๒๓๔' }, 'pin'],
    ['PIN sent as a number', { pin: 1234 }, 'pin'],
    ['empty name', { name: '' }, 'name'],
    ['name of only spaces', { name: '   ' }, 'name'],
    ['name of 33 characters', { name: 'ก'.repeat(33) }, 'name'],
    ['empty invite code', { inviteCode: ' ' }, 'inviteCode'],
  ])('rejects %s and names the field', (_label, patch, field) => {
    const errors = joinFieldErrors({ ...valid, ...patch });

    expect(Object.keys(errors)).toEqual([field]);
    expect(errors[field as keyof typeof errors]).toMatch(/\S/);
  });

  it('names every wrong field at once, in Thai', () => {
    const errors = joinFieldErrors({ inviteCode: 'ABC', name: '', pin: '12' });

    expect(errors).toEqual({
      name: 'กรุณาใส่ชื่อผู้เล่น',
      pin: 'PIN ต้องเป็นตัวเลข 4-6 หลัก',
    });
  });

  it('trims the name and folds inner whitespace before checking the length', () => {
    const parsed = JoinRequest.parse({ ...valid, name: `  นก   น้อย  ` });

    expect(parsed.name).toBe('นก น้อย');
  });
});

describe('name and invite code normalisation', () => {
  it('treats names that differ only by case or spacing as the same player', () => {
    expect(nameKey(' Nok  Lee ')).toBe(nameKey('nok lee'));
    expect(nameKey('NOK')).toBe('nok');
  });

  it('reads an invite code without caring about case, spaces or dashes', () => {
    expect(normalizeInviteCode(' k7q-2mx ')).toBe('K7Q2MX');
  });
});
