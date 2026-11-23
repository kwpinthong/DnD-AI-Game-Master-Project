import { describe, expect, it } from 'vitest';
import { containsName as hasWord } from '../src/gm/check.ts';
import { exampleTokens, PLAYER_TOKEN } from '../src/gm/npc-examples.ts';

/** GEN-202: a short Thai lobby name is swapped only where it stands as a whole word (Intl.Segmenter). */
describe('scrub whole words only', () => {
  it('C1: lobby name นก inside เป็นกลาง is not swapped and does not count as named', () => {
    expect(exampleTokens('เขาวางตัวเป็นกลาง', [], ['นก'])).toBe('เขาวางตัวเป็นกลาง');
    expect(hasWord('เขาวางตัวเป็นกลาง', 'นก')).toBe(false);
  });

  it('C2: นกเดินไป swaps the name', () => {
    expect(exampleTokens('นกเดินไป', [], ['นก'])).toBe(`${PLAYER_TOKEN}เดินไป`);
    expect(hasWord('นกเดินไป', 'นก')).toBe(true);
  });

  it('a name glued to Thai text in another script is still swapped; inside a longer Latin word it is not', () => {
    expect(exampleTokens('ของNok', [], ['Nok'])).toBe(`ของ${PLAYER_TOKEN}`);
    expect(exampleTokens('Nokia', [], ['Nok'])).toBe('Nokia');
    // ICU cuts an unknown name oddly (ลิ|นที่): it still swaps, while ลิน inside คลินิก stays
    expect(exampleTokens('หาลินที่คลินิก', [], ['ลิน'])).toBe(`หา${PLAYER_TOKEN}ที่คลินิก`);  });

  it('NPC names and multi-word names still swap, longest first', () => {
    expect(exampleTokens('คุณนกครับ ลุงสมชายมา', [{ id: 'npc_1', names: ['ลุงสมชาย'] }], ['นก'])).toBe(`คุณ${PLAYER_TOKEN}ครับ {{n:npc_1}}มา`);
  });
});
