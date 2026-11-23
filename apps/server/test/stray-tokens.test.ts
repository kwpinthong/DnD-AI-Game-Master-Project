import { describe, expect, it } from 'vitest';
import type { GmWorld } from '../src/gm/context.ts';
import { renderTokens } from '../src/gm/loop.ts';

/** GEN-152: a token of a wrong kind ({{place}}) must never reach a player as raw text. */
const world = {
  npcs: [{ id: 'sera', name: 'เซร่า', alias: 'หญิงชุดเขียว' }],
  byRef: new Map([['p1', { memberId: 'm1', name: 'อาริน', socialTitle: 'นักเดินทาง' }]]),
  knownNames: () => new Set<string>(),
} as unknown as GmWorld;
const render = (t: string, shared = false) => renderTokens(null as never, world, t, null, shared);

describe('GEN-152 stray tokens', () => {
  it('C1: {{place}} / unknown kinds / half tokens are removed', () => {
    for (const t of ['เดินเข้า {{place}} ช้า ๆ', 'a {{x:1}} b', 'a {{ b', 'a }} b', 'a {{p:}} b', 'a {{p:zz y}} b']) {
      expect(render(t)).not.toMatch(/\{\{|\}\}/);
    }
    expect(render('เดินเข้า {{place}} ช้า ๆ')).toBe('เดินเข้า ช้า ๆ');
  });
  it('C2: valid p / n tokens still work', () => {
    expect(render('{{p:p1}} คุยกับ {{n:sera}}')).toBe('นักเดินทาง คุยกับ หญิงชุดเขียว');
  });
  it('C3: an NPC line with a stray token is neutralised', () => {
    expect(render('ข้าอยู่ที่ {{town}} นี่แหละ')).toBe('ข้าอยู่ที่ นี่แหละ');
  });
});
