import { describe, expect, it } from 'vitest';
import { GmDialogue, GmNarration } from '../src/gm/schema.ts';
import { NPC_LINE_LIMITS, capTotal, cleanNpcLines, cutLine, lingerAfter, lingerNow, npcsPresentAt, type CleanLine, type Linger, type RawLine } from '../src/gm/npc-lines.ts';
import type { GameAssets } from '../src/assets/load.ts';
import type { GmWorld } from '../src/gm/context.ts';

/** GEN-110: what the server keeps of the NPC lines the AI GM wrote with a narration (limits, ids, names, Thai-safe cut). */

const line = (npcId: string, kind: 'dialogue' | 'reaction', text: string): RawLine => ({ npcId, kind, text });
const present = (...ids: string[]) => new Set(ids);
const NONE = { forbidden: [] as string[], cast: new Set<string>() };

describe('GEN-137 (Q-300) who is here: the schedule now, else the scenario place', () => {
  const world = {
    places: [
      { id: 'fountain', name: 'น้ำพุกลางเมือง' },
      { id: 'clinic', name: 'สถานพยาบาลกลาง' },
    ],
    npcs: [
      { id: 'lucia', names: ['ลูเซีย'], locationId: 'fountain' },
      { id: 'noah', names: ['โนอา'], locationId: 'fountain' },
      { id: 'merchant', names: ['มาร์คัส'], locationId: 'fountain' },
    ],
  } as unknown as GmWorld;
  const row = (npc: string, location: string, periods: string[], weathers: string[] = []) => ({ npc, location, periods, weathers, condition: '', note: '' });
  const assets = {
    npcSchedule: [row('ลูเซีย', 'น้ำพุกลางเมือง', ['SOLARION']), row('โนอา', 'น้ำพุกลางเมือง', ['SOLARION']), row('โนอา', 'สถานพยาบาลกลาง', ['EOSORIA'])],
  } as unknown as GameAssets;
  const here = (placeId: string, phase: 'EOSORIA' | 'SOLARION' | 'HESPERION', weather: 'Rain' | null = null) =>
    npcsPresentAt(world, assets, placeId, { phase, weather, karmas: [] }).map((n) => n.id).sort();

  it('C1: an NPC with no schedule row at all, or none for this period, is at its scenario place', () => {
    // merchant has no row; lucia has none for HESPERION; noah has none for HESPERION either.
    expect(here('fountain', 'HESPERION')).toEqual(['lucia', 'merchant', 'noah']);
    expect(here('clinic', 'HESPERION')).toEqual([]);
  });

  it('C2: an NPC the schedule puts elsewhere for this period is not here, even at its scenario place', () => {
    expect(here('fountain', 'EOSORIA')).toEqual(['lucia', 'merchant']);
    expect(here('clinic', 'EOSORIA')).toEqual(['noah']);
    // Scheduled here now: here, as before.
    expect(here('fountain', 'SOLARION')).toEqual(['lucia', 'merchant', 'noah']);
  });
});

describe('GEN-144 the conversation partner stays past its schedule (at most 2 turns), then says goodbye', () => {
  const world = {
    places: [
      { id: 'fountain', name: 'น้ำพุกลางเมือง' },
      { id: 'temple', name: 'โบสถ์' },
      { id: 'market', name: 'ตลาด' },
    ],
    npcs: [
      { id: 'malcolm', names: ['มัลคอล์ม'], locationId: 'temple' },
      { id: 'lucia', names: ['ลูเซีย'], locationId: 'temple' },
      { id: 'noah', names: ['โนอา'], locationId: 'fountain' },
    ],
  } as unknown as GmWorld;
  const row = (npc: string, location: string, periods: string[]) => ({ npc, location, periods, weathers: [], condition: '', note: '' });
  // Malcolm and Lucia are at the fountain at EOSORIA only; at SOLARION both are back at the temple.
  const assets = { npcSchedule: [row('มัลคอล์ม', 'น้ำพุกลางเมือง', ['EOSORIA']), row('ลูเซีย', 'น้ำพุกลางเมือง', ['EOSORIA'])] } as unknown as GameAssets;
  const solarion = { phase: 'SOLARION' as const, weather: null, karmas: [] };
  const scheduledAt = (npcId: string, placeId: string) => npcsPresentAt(world, assets, placeId, solarion).some((n) => n.id === npcId);
  const here = (placeId: string, lingering: readonly Linger[]) => npcsPresentAt(world, assets, placeId, { ...solarion, lingering }).map((n) => n.id).sort();
  /** One turn: who lingers and who says goodbye now, then the state the turn leaves after `talked`. */
  const turn = (prev: readonly Linger[], talked: { npcId: string; placeId: string }[]) => {
    const now = lingerNow(prev, scheduledAt);
    return { ...now, next: lingerAfter(now.lingering, talked) };
  };
  const atFountain = (npcId: string) => ({ npcId, placeId: 'fountain' });

  it('C1: talked to on the last turn of EOSORIA, it is still at the fountain when SOLARION starts (and not at its scheduled place)', () => {
    const t1 = turn(lingerAfter([], [atFountain('malcolm')]), []);
    expect(t1.lingering.map((l) => [l.npcId, l.placeId, l.used])).toEqual([['malcolm', 'fountain', 1]]);
    expect(t1.farewells).toEqual([]);
    expect(here('fountain', t1.lingering)).toEqual(['malcolm', 'noah']);
    expect(here('temple', t1.lingering)).toEqual(['lucia']);
  });

  it('C2: talked to again while lingering, it stays a 2nd turn; on the 3rd it is gone with one farewell', () => {
    const t1 = turn(lingerAfter([], [atFountain('malcolm')]), [atFountain('malcolm')]);
    const t2 = turn(t1.next, [atFountain('malcolm')]);
    expect(t2.lingering.map((l) => [l.npcId, l.used])).toEqual([['malcolm', 2]]);
    expect(here('fountain', t2.lingering)).toContain('malcolm');
    // Gone from the fountain: nobody there can talk to it any more.
    const t3 = turn(t2.next, []);
    expect(t3.lingering).toEqual([]);
    expect(t3.farewells.map((f) => [f.npcId, f.placeId])).toEqual([['malcolm', 'fountain']]);
    expect(here('fountain', t3.lingering)).not.toContain('malcolm');
    expect(here('temple', t3.lingering)).toContain('malcolm');
    // The farewell is said once: the turn after it, nothing is left of it.
    expect(t3.next).toEqual([]);
    expect(turn(t3.next, []).farewells).toEqual([]);
  });

  it('C3: lingering but nobody talked to it this turn: next turn it follows the schedule, with a farewell', () => {
    const t1 = turn(lingerAfter([], [atFountain('malcolm')]), []);
    const t2 = turn(t1.next, []);
    expect(t2.lingering).toEqual([]);
    expect(t2.farewells.map((f) => f.npcId)).toEqual(['malcolm']);
    expect(here('temple', t2.lingering)).toContain('malcolm');
  });

  it('C5: two NPCs each talked to both linger', () => {
    const t1 = turn(lingerAfter([], [atFountain('malcolm'), atFountain('lucia')]), []);
    expect(t1.lingering.map((l) => l.npcId).sort()).toEqual(['lucia', 'malcolm']);
    expect(here('fountain', t1.lingering)).toEqual(['lucia', 'malcolm', 'noah']);
  });

  it('C6: the NPC stays at the place it was talked to; it does not follow the player elsewhere', () => {
    const t1 = turn(lingerAfter([], [atFountain('malcolm')]), []);
    expect(here('market', t1.lingering)).toEqual([]);
    expect(here('fountain', t1.lingering)).toContain('malcolm');
  });

  it('an NPC talked to where the schedule keeps it anyway does not linger and says no goodbye', () => {
    const t1 = turn(lingerAfter([], [atFountain('noah')]), []);
    expect(t1).toMatchObject({ lingering: [], farewells: [] });
  });

  it('C8: an old game has no state: nobody lingers and nobody says goodbye', () => {
    expect(lingerNow([], scheduledAt)).toEqual({ lingering: [], farewells: [] });
    expect(here('fountain', [])).toEqual(['noah']);
    expect(npcsPresentAt(world, assets, 'fountain', solarion).map((n) => n.id)).toEqual(['noah']);
  });
});

describe('GEN-110 NPC lines: the server trims what the AI sends', () => {
  it('C7: a line of 300 characters is cut to 120 at a word boundary, never inside a Thai cluster', () => {
    const long = 'ข้าไม่เคยเห็นใครกล้าเดินเข้ามาในโบสถ์ตอนกลางคืนแบบนี้มาก่อนเลยนะ '.repeat(6);
    const cut = cutLine(long);
    expect(cut.length).toBeLessThanOrEqual(NPC_LINE_LIMITS.chars);
    expect(cut.endsWith('…')).toBe(true);
    const body = cut.slice(0, -1);
    expect(long.startsWith(body.trimEnd())).toBe(true);
    // not in the middle of a syllable: no leading vowel left hanging, and the next char is not a combining mark
    expect(/[เแโใไ]$/u.test(body)).toBe(false);
    expect(/^\p{M}/u.test(long.slice(body.length))).toBe(false);
  });

  it('C7: every cut length stays Thai-safe (the cut never ends before a combining mark or after a leading vowel)', () => {
    const thai = 'ผู้กล้าที่เดินทางมาจากแดนไกลเพื่อตามหาความจริงของเมืองนี้ ';
    for (let n = 20; n < 200; n += 7) {
      const cut = cutLine(thai.repeat(5).slice(0, n * 3), n);
      const body = cut.endsWith('…') ? cut.slice(0, -1) : cut;
      expect(cut.length).toBeLessThanOrEqual(n);
      expect(/[เแโใไ]$/u.test(body)).toBe(false);
      expect(/^\p{M}/u.test(thai.repeat(5).slice(body.length))).toBe(false);
    }
  });

  it('a short line stays as written (whitespace tidied)', () => {
    expect(cutLine('  ยินดีต้อนรับ   นักเดินทาง ')).toBe('ยินดีต้อนรับ นักเดินทาง');
  });

  it('C7 + C3: unknown ids and NPCs that are not at the place are dropped, the rest stays', () => {
    const lines = [line('lucia', 'dialogue', 'สวัสดี'), line('ghost', 'dialogue', 'ฉันไม่มีจริง'), line('guard', 'reaction', 'ไม่ได้อยู่ที่นี่')];
    expect(cleanNpcLines(lines, { present: present('lucia', 'noah'), audience: 'public', ...NONE })).toEqual([line('lucia', 'dialogue', 'สวัสดี')]);
  });

  it('C7: 15 lines and 5 reacting NPCs come out as at most 3 lines of the main NPC and 3 reactions of 1 line each', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const raw: RawLine[] = [
      ...Array.from({ length: 6 }, (_, i) => line('a', 'dialogue', `พูดครั้งที่ ${i + 1}`)),
      ...ids.slice(1).flatMap((id) => [line(id, 'reaction', `${id} มองดู`), line(id, 'reaction', `${id} มองอีกที`)]),
      line('e', 'reaction', 'ท้ายสุด'),
    ];
    expect(raw).toHaveLength(15);
    const out = cleanNpcLines(raw, { present: present(...ids), audience: 'public', ...NONE });
    expect(out.filter((l) => l.kind === 'dialogue').map((l) => l.text)).toEqual(['พูดครั้งที่ 1', 'พูดครั้งที่ 2', 'พูดครั้งที่ 3']);
    const reactions = out.filter((l) => l.kind === 'reaction');
    expect(reactions.map((l) => l.npcId)).toEqual(['b', 'c', 'd']);
    expect(new Set(reactions.map((l) => l.npcId)).size).toBe(reactions.length);
  });

  it('an NPC that speaks does not also react', () => {
    const out = cleanNpcLines([line('a', 'dialogue', 'พูด'), line('a', 'reaction', 'มอง')], { present: present('a'), audience: 'public', ...NONE });
    expect(out).toEqual([line('a', 'dialogue', 'พูด')]);
  });

  it('private: at most 2 lines for the one reader', () => {
    const out = cleanNpcLines([line('a', 'dialogue', '1'), line('a', 'dialogue', '2'), line('a', 'dialogue', '3')], { present: present('a'), audience: 'private', ...NONE });
    expect(out.map((l) => l.text)).toEqual(['1', '2']);
  });

  it('C5: a line with a real name the reader does not know, or a token outside the cast, is dropped', () => {
    const out = cleanNpcLines(
      [line('s', 'dialogue', 'ข้าคือออเรเลีย'), line('s', 'dialogue', 'เจ้าคือ {{p:zzz}}'), line('s', 'dialogue', 'เจ้าคือ {{p:ok}}'), line('s', 'dialogue', 'มองที่ {{n:s}}')],
      { present: present('s'), audience: 'public', forbidden: ['ออเรเลีย'], cast: new Set(['ok']) },
    );
    expect(out.map((l) => l.text)).toEqual(['เจ้าคือ {{p:ok}}', 'มองที่ {{n:s}}']);
  });

  it('an empty line is dropped', () => {
    expect(cleanNpcLines([line('a', 'dialogue', '   ')], { present: present('a'), audience: 'public', ...NONE })).toEqual([]);
  });

  it('the turn keeps at most 12 lines, in order', () => {
    const many: CleanLine[] = Array.from({ length: 20 }, (_, i) => ({ npcId: 'a', kind: 'dialogue', text: String(i) }));
    expect(capTotal(many).map((l) => l.text)).toEqual(Array.from({ length: NPC_LINE_LIMITS.total }, (_, i) => String(i)));
  });

  it('GEN-116 C5: the level changes the most lines accepted: low < normal (and a game with none) < high', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const raw: RawLine[] = [
      ...Array.from({ length: 8 }, (_, i) => line('a', 'dialogue', `พูดครั้งที่ ${i + 1}`)),
      ...ids.slice(1).map((id) => line(id, 'reaction', `${id} มองดู`)),
    ];
    const count = (level?: 'low' | 'normal' | 'high') => {
      const out = cleanNpcLines(raw, { present: present(...ids), audience: 'public', ...NONE, ...(level ? { level } : {}) });
      return { dialogue: out.filter((l) => l.kind === 'dialogue').length, reactions: out.filter((l) => l.kind === 'reaction').length };
    };
    expect(count('low')).toEqual({ dialogue: 2, reactions: 2 });
    expect(count('normal')).toEqual({ dialogue: 3, reactions: 3 });
    expect(count()).toEqual(count('normal'));
    expect(count('high')).toEqual({ dialogue: 6, reactions: 6 });
    const many = Array.from({ length: 40 }, (_, i) => i);
    expect([capTotal(many, 'low'), capTotal(many), capTotal(many, 'high')].map((l) => l.length)).toEqual([6, 12, 24]);
    const priv = (level?: 'low' | 'high') => cleanNpcLines([1, 2, 3, 4, 5].map((i) => line('a', 'dialogue', String(i))), { present: present('a'), audience: 'private', ...NONE, ...(level ? { level } : {}) }).length;
    expect([priv('low'), priv(), priv('high')]).toEqual([1, 2, 4]);
  });

  it('GEN-116: a narration carries no npcLines; an old stored one that has them still parses (the key is dropped)', () => {
    const parsed = GmNarration.parse({ segments: [{ actionId: 'act-1', text: 'เล่า' }], npcLines: [line('a', 'dialogue', 'เก่า')] });
    expect(parsed).toEqual({ segments: [{ actionId: 'act-1', text: 'เล่า' }] });
  });

  it('the dialogue schema accepts a long answer so the server (not a repair) trims it', () => {
    const lines = Array.from({ length: 15 }, () => line('a', 'dialogue', 'ก'.repeat(300)));
    expect(GmDialogue.safeParse({ npcLines: lines }).success).toBe(true);
  });
});
