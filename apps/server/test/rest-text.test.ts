import { describe, expect, it } from 'vitest';
import { isOwnRestText } from '../src/game/rest-text.ts';

describe('GEN-113 isOwnRestText', () => {
  it.each(['นอน', 'พักผ่อน', 'งีบสักพัก', 'rest', 'Sleep', 'พัก', 'พักที่โรงเตี๊ยม', 'ขอนอนหน่อย', 'I will rest a bit', 'นอนหลับ!'])('%s is REST', (t) => {
    expect(isOwnRestText(t)).toBe(true);
  });
  it.each(['หลอกให้ยามนอนหลับ', 'put the guard to sleep', 'พักแล้วค่อยออกไปล่า', 'เดินเล่น', 'นอนกับยาม', ''])('%s is not REST', (t) => {
    expect(isOwnRestText(t)).toBe(false);
  });
});

describe('GEN-159 isOwnRestText: the rest button\'s "พัก" with more typed after it', () => {
  it.each(['พัก นอนที่โรงเตี๊ยม', 'พักผ่อนที่น้ำพุ', 'พัก งีบสักพัก', 'นอนที่ลานกว้าง', 'rest sleep'])('%s is REST', (t) => {
    expect(isOwnRestText(t)).toBe(true);
  });
  it.each(['ให้โนอาพัก', 'ไม่พัก', 'พัก ไม่นอน', 'พักที่โรงเตี๊ยมแล้วออกไปล่า', 'นอนที่น้ำพุและขโมยของ', 'พัก ไปล่าสัตว์'])('%s is not REST', (t) => {
    expect(isOwnRestText(t)).toBe(false);
  });
});
