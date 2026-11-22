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
