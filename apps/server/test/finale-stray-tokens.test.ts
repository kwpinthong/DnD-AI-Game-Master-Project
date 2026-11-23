import { describe, expect, it } from 'vitest';
import type { GmWorld } from '../src/gm/context.ts';
import { revealTokens } from '../src/gm/finale.ts';

/** GEN-156: the ending text drops stray {{...}} tokens like the GM feed does (GEN-152); real names after the end (GEN-059). */
const world = {
  npcs: [{ id: 'sera', name: 'เซร่า', alias: 'หญิงชุดเขียว' }],
  byRef: new Map([['p1', { memberId: 'm1', name: 'อาริน', socialTitle: 'นักเดินทาง' }]]),
} as unknown as GmWorld;

describe('GEN-156 stray tokens in the ending', () => {
  it('C1: {{place}} / unknown kinds / half tokens never reach the player raw', () => {
    for (const t of ['เมืองรอด {{place}} สงบลง', 'a {{x:1}} b', 'a {{ b', 'a }} b', 'a {{p:}} b', 'a {{p:zz y}} b']) {
      expect(revealTokens(world, t)).not.toMatch(/\{\{|\}\}/);
    }
    expect(revealTokens(world, 'เมืองรอด {{place}} สงบลง')).toBe('เมืองรอด สงบลง');
  });
  it('C2: valid p / n tokens become real names as before', () => {
    expect(revealTokens(world, '{{p:p1}} คุยกับ {{n:sera}}')).toBe('อาริน คุยกับ เซร่า');
    expect(revealTokens(world, '{{p:nobody}} หายไป')).toBe(' หายไป');
  });
});
