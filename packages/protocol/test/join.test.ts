import { describe, expect, it } from 'vitest';
import {
  CreateGameRequest,
  createGameFieldErrors,
  joinFieldErrors,
  JoinRequest,
  nameKey,
  normalizeInviteCode,
  normalizePin,
} from '../src/index.ts';

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
    ['PIN with a space in the middle', { pin: '12 34' }, 'pin'],
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

// GEN-092: a Thai keyboard gives Thai digits or Thai letters on the number row.
describe('PIN typed on a Thai keyboard (GEN-092)', () => {
  it('C1: Thai digits are read as the same PIN as Arabic digits', () => {
    expect(JoinRequest.parse({ ...valid, pin: '๑๒๓๔' }).pin).toBe('1234');
    expect(JoinRequest.parse({ ...valid, pin: '๐๙๘๗๖๕' }).pin).toBe('098765');
    expect(normalizePin('๑2๓4')).toBe('1234');
  });

  it('C2: spaces around the PIN are dropped', () => {
    expect(JoinRequest.parse({ ...valid, pin: ' 1234 ' }).pin).toBe('1234');
    expect(JoinRequest.parse({ ...valid, pin: '\t๑๒๓๔\n' }).pin).toBe('1234');
  });

  it('C3: Thai letters from the number row are refused with a hint about the keyboard', () => {
    const errors = joinFieldErrors({ ...valid, pin: 'ๅ/-ภ' });

    expect(Object.keys(errors)).toEqual(['pin']);
    expect(errors.pin).toContain('PIN ต้องเป็นตัวเลข 4-6 หลัก');
    expect(errors.pin).toContain('แป้นพิมพ์อาจเป็นภาษาไทย');
  });

  it('C3: a PIN that is only too short keeps the plain message', () => {
    expect(joinFieldErrors({ ...valid, pin: '123' }).pin).toBe('PIN ต้องเป็นตัวเลข 4-6 หลัก');
    expect(joinFieldErrors({ ...valid, pin: '12a4' }).pin).toBe('PIN ต้องเป็นตัวเลข 4-6 หลัก');
  });

  it.each([
    ['3 digits', '123', false],
    ['4 digits', '1234', true],
    ['5 digits', '12345', true],
    ['6 digits', '123456', true],
    ['7 digits', '1234567', false],
    ['3 Thai digits', '๑๒๓', false],
    ['4 Thai digits', '๑๒๓๔', true],
    ['6 Thai digits', '๑๒๓๔๕๖', true],
    ['7 Thai digits', '๑๒๓๔๕๖๗', false],
  ])('C5: a PIN of %s passes = %s', (_label, pin, ok) => {
    expect(JoinRequest.safeParse({ ...valid, pin }).success).toBe(ok);
  });

  it('the create-game body reads the PIN the same way', () => {
    const body = { createCode: 'x', gameName: 'เกม', mode: 'online', humanGm: false, name: 'นก', pin: ' ๑๒๓๔ ' };
    expect(CreateGameRequest.parse(body).pin).toBe('1234');
    expect(createGameFieldErrors({ ...body, pin: 'ๅ/-ภ' }).pin).toContain('แป้นพิมพ์อาจเป็นภาษาไทย');
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
