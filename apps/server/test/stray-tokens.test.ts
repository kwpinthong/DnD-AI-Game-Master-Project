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

describe('GEN-143 rendered names: "คุณ" without spaces, a title the text repeats shown once', () => {
  const people = {
    npcs: [],
    byRef: new Map([
      ['me', { memberId: 'm-me', name: 'นก', socialTitle: 'คนแปลกหน้า' }],
      ['twin', { memberId: 'm-twin', name: 'บี', socialTitle: 'ผมดำยาว' }],
      ['other', { memberId: 'm-other', name: 'ซี', socialTitle: 'นักเดินทาง' }],
    ]),
    knownNames: () => new Set<string>(),
  } as unknown as GmWorld;
  const readBy = (t: string, reader: string | null = 'm-me') => renderTokens(null as never, people, t, reader);

  it('C6: {{p:me}} read by me is "คุณ" with no space around it, at the start and in the middle of a sentence', () => {
    expect(readBy('เสียงของ {{p:me}} ถูกรับฟัง')).toBe('เสียงของคุณถูกรับฟัง');
    expect(readBy('{{p:me}} ถูกรับฟัง')).toBe('คุณถูกรับฟัง');
    expect(readBy('ทุกคนหันมามอง {{p:me}}')).toBe('ทุกคนหันมามองคุณ');
    // A line break stays; another person's name keeps its spaces.
    expect(readBy('บรรทัดแรก\n{{p:me}} เดินต่อ')).toBe('บรรทัดแรก\nคุณเดินต่อ');
    expect(readBy('{{p:other}} คุยกับ {{p:me}} อยู่')).toBe('นักเดินทาง คุยกับคุณอยู่');
  });

  it('C5: a title the text also writes as the look right next to it shows once; a different look stays', () => {
    expect(readBy('{{p:twin}} ผมดำยาว ยืนอยู่ข้างน้ำพุ')).toBe('ผมดำยาว ยืนอยู่ข้างน้ำพุ');
    expect(readBy('ผมดำยาว {{p:twin}} ยืนอยู่')).toBe('ผมดำยาว ยืนอยู่');
    expect(readBy('{{p:other}} ผมดำยาว ยืนอยู่')).toBe('นักเดินทาง ผมดำยาว ยืนอยู่');
  });
});
