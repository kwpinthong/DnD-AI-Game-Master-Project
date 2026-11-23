import { RoomViewLockCode } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { describe, expect, it } from 'vitest';
import { bondBar, entrySection, injuryWord, lockTitle, nextTurn, omenBlocked, rollLine, secretQuota, staminaWord, topBar, turnChangeText, turnName } from '../src/screen-models.ts';

// GEN-099: the web reads the contract's fixtures through its own view-models (the mock layer of GEN-100 uses the same).
describe('screen view-models over the contract fixtures', () => {
  it('UI-I3: every entry kind goes to its section (feed → place, narration / whisper / omen → private, hit → pin)', () => {
    const sections = CONTRACT_FIXTURES.RoomEntry.map((e) => [e.kind, entrySection(e)]);
    expect(Object.fromEntries(sections)).toEqual({ feed: 'place', narration: 'private', whisper: 'private', omen: 'private', hit: 'pin', changes: 'private', npc: 'place', player: 'place' });
  });

  it('GEN-114: a turn change reads "what +/-n · why"; karma only as the status bar word', () => {
    expect(turnChangeText({ stat: 'stamina', delta: -3, reason: 'เดินทางข้ามโซน' })).toBe('แรง -3 · เดินทางข้ามโซน');
    expect(turnChangeText({ stat: 'coins', delta: 5, reason: 'x' })).toBe('เหรียญ +5 · x');
    expect(turnChangeText({ stat: 'conduct', from: 'เป็นกลาง', to: 'ใจดี', reason: 'x' })).toBe('ความประพฤติ เป็นกลาง → ใจดี · x');
    expect(turnChangeText({ stat: 'item_lost', name: 'Dagger', reason: 'ถูกแย่งไป' })).toBe('ของหาย: Dagger · ถูกแย่งไป');
  });

  it('top bar: day, the current period with its turn dots, weather words and "ส่งแล้ว n/m" (none in Single)', () => {
    const [online] = CONTRACT_FIXTURES.RoomState;
    const bar = topBar(online as Parameters<typeof topBar>[0]);
    expect(bar.day).toBe('วันที่ 3/12');
    expect(bar.periods.map((p) => [p.phase, p.current, p.turns.join(',')])).toEqual([
      ['EOSORIA', false, 'done,done'],
      ['SOLARION', true, 'current,todo'],
      ['HESPERION', false, 'todo,todo'],
      ['NOCTHERION', false, 'todo,todo'],
    ]);
    expect(bar.weather).toBe('ฝนตก');
    expect(bar.submitted).toBe('ส่งแล้ว 3/3');
    const single = CONTRACT_FIXTURES.RoomState.find((s) => s.mode === 'single')!;
    expect(topBar(single as Parameters<typeof topBar>[0]).submitted).toBeNull();
  });

  it('F5 roll line and F4 bond bar are words / steps, no number but the d20 face', () => {
    expect(rollLine(CONTRACT_FIXTURES.RollView[0] as Parameters<typeof rollLine>[0])).toBe('ทอย d20 = 14 · ยาก · สำเร็จ');
    expect(bondBar({ word: 'สนิท', step: 5 })).toEqual([true, true, true, true, true, false]);
  });

  it('GEN-088: the turn after this one, and the words for HP / Stamina by their share of the maximum (Q-197)', () => {
    expect(nextTurn({ day: 3, phase: 'SOLARION', turn: 1 })).toEqual({ day: 3, phase: 'SOLARION', turn: 2 });
    expect(nextTurn({ day: 3, phase: 'SOLARION', turn: 2 })).toEqual({ day: 3, phase: 'HESPERION', turn: 1 });
    expect(nextTurn({ day: 3, phase: 'NOCTHERION', turn: 2 })).toEqual({ day: 4, phase: 'EOSORIA', turn: 1 });
    expect(turnName({ day: 4, phase: 'EOSORIA', turn: 1 }, 3)).toBe('วันที่ 4 · EOSORIA เทิร์น 1');
    // Max HP 30: 15 is still ปกติ, 8 บาดเจ็บ, 7 สาหัส, 0 สลบ
    expect([30, 15, 14, 8, 7, 1, 0].map((current) => injuryWord({ current, max: 30 }))).toEqual(['ปกติ', 'ปกติ', 'บาดเจ็บ', 'บาดเจ็บ', 'สาหัส', 'สาหัส', 'สลบ']);
    expect([30, 15, 8, 7, 0].map((current) => staminaWord({ current, max: 30 }))).toEqual(['ปกติ', 'ปกติ', 'เหนื่อย', 'ใกล้หมดแรง', 'หมดแรง']);
  });

  it('GEN-088: the Secret quota and the omen say when they come back', () => {
    const at = (day: number, phase: 'SOLARION' | 'NOCTHERION', secretUsed: boolean) => ({ day, phase, you: { secretUsed } });
    expect(secretQuota(at(3, 'SOLARION', false))).toEqual({ status: 'วันนี้เหลือ 1', blocked: null });
    expect(secretQuota(at(3, 'NOCTHERION', false)).status).toBe('คืนนี้ลับฟรี 1');
    expect(secretQuota(at(3, 'SOLARION', true))).toEqual({ status: 'ใช้แล้ว รีเซ็ตเช้าวันที่ 4', blocked: 'ใช้ลับวันนี้แล้ว รีเซ็ตเช้าวันที่ 4' });
    // the last day has no next morning to promise
    expect(secretQuota(at(12, 'NOCTHERION', true))).toEqual({ status: 'ใช้แล้ว', blocked: 'ใช้ลับฟรีของคืนนี้แล้ว' });
    expect(omenBlocked({ day: 6, phase: 'NOCTHERION' }, true)).toBeNull();
    expect(omenBlocked({ day: 6, phase: 'SOLARION' }, false)).toBe('ส่งลางสังหรณ์ได้อีกครั้งคืนนี้ ช่วง NOCTHERION');
    expect(omenBlocked({ day: 6, phase: 'NOCTHERION' }, false)).toMatch(/วันที่ 7$/);
  });

  it('every lock code of the contract has a title', () => {
    for (const code of RoomViewLockCode.options) expect(lockTitle(code)).not.toBe('');
  });
});
