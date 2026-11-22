import { describe, expect, it } from 'vitest';
import { socialTitle, STARTING_STATS } from '../src/index.ts';

describe('starting stats + Social Title (GEN-047)', () => {
  it('C1: a new character starts at HP 100/100, Stamina 30/30, Reputation 0, Karma 0', () => {
    expect(STARTING_STATS).toEqual({ hp: 100, hpMax: 100, stamina: 30, staminaMax: 30, reputation: 0, karma: 0 });
  });

  it('C1: Reputation 0 is "คนแปลกหน้า"', () => {
    expect(socialTitle(STARTING_STATS.reputation)).toBe('คนแปลกหน้า');
  });

  it.each([
    [-100, 'ภัยของเมือง'],
    [-61, 'ภัยของเมือง'],
    [-60, 'เงามืดผู้ต้องสงสัย'],
    [-31, 'เงามืดผู้ต้องสงสัย'],
    [-30, 'คนน่าสงสัย'],
    [-11, 'คนน่าสงสัย'],
    [-10, 'คนแปลกหน้า'],
    [10, 'คนแปลกหน้า'],
    [11, 'คนคุ้นหน้า'],
    [30, 'คนคุ้นหน้า'],
    [31, 'ผู้ใจบุญ'],
    [60, 'ผู้ใจบุญ'],
    [61, 'วีรชนแห่งเมือง'],
    [100, 'วีรชนแห่งเมือง'],
  ])('Reputation %i is "%s" (Rules Spec tier edges)', (reputation, title) => {
    expect(socialTitle(reputation)).toBe(title);
  });});
