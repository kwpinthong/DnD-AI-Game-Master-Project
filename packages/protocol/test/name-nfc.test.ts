import { describe, expect, it } from 'vitest';
import { CreateGameRequest, JoinRequest, NAME_MAX_LENGTH, nameKey, normalizePlayerName } from '../src/index.ts';

/** GEN-106 (Q-228): names are NFC, so sara am (ำ U+0E33) stays one code point; NFKC split it. */
const SARA_AM = 'ำ';
const SPLIT = 'ํา';

describe('player and game names are NFC (GEN-106)', () => {
  it('C1: a typed ำ is stored as one code point', () => {
    expect(normalizePlayerName('คำแก้ว')).toBe('คำแก้ว');
    expect(normalizePlayerName('คำแก้ว')).toContain(SARA_AM);
    const parsed = JoinRequest.parse({ inviteCode: 'ABC123', name: ' คำแก้ว ', pin: '1234' });
    expect(parsed.name).toBe('คำแก้ว');
  });

  it('C1: a name typed with the split form joins as the same name and key', () => {
    const split = `ค${SPLIT}แก้ว`;
    expect(normalizePlayerName(split)).toBe('คำแก้ว');
    expect(nameKey(split)).toBe(nameKey('คำแก้ว'));
  });

  it('C2: a game name keeps ำ whole', () => {
    const parsed = CreateGameRequest.parse({ gameName: ' เกมคำสาป ', createCode: 'x', mode: 'online', humanGm: false, name: 'a', pin: '1234' });
    expect(parsed.gameName).toBe('เกมคำสาป');
    expect(parsed.gameName).toContain(SARA_AM);
  });

  it('C6: the length counts after NFC; at the ceiling passes, one over fails', () => {
    const atCeiling = 'ก' + 'ำ'.repeat(NAME_MAX_LENGTH - 1);
    expect(JoinRequest.safeParse({ inviteCode: 'ABC123', name: atCeiling, pin: '1234' }).success).toBe(true);
    expect(JoinRequest.safeParse({ inviteCode: 'ABC123', name: `${atCeiling}ก`, pin: '1234' }).success).toBe(false);
  });
});
