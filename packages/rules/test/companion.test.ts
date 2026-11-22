import { describe, expect, it } from 'vitest';
import {
  applyAffinityDelta,
  checkNpcReward,
  checkNpcSpawn,
  evolveNpc,
  isCrisisAid,
  rankCompanions,
  revealsNpcName,
  type EvolutionInput,
} from '../src/index.ts';

const base: EvolutionInput = { grade: 'F', affinity: 0, karma: 0, crisisAided: false, nightEnd: true };

describe('NPC companions, grades and evolution (GEN-054)', () => {
  it('C2: the main companion is the one with the highest affinity', () => {
    const { main, secondary } = rankCompanions([
      { npcId: 'orphan', affinity: 12, seq: 1 },
      { npcId: 'merchant', affinity: 30, seq: 2 },
      { npcId: 'spy', affinity: -5, seq: 3 },
    ]);
    expect(main?.npcId).toBe('merchant');
    expect(secondary.map((s) => s.npcId)).toEqual(['orphan', 'spy']);
  });

  it('C2: on a tie the companion saved first is the main one', () => {
    const { main } = rankCompanions([
      { npcId: 'later', affinity: 20, seq: 5 },
      { npcId: 'first', affinity: 20, seq: 2 },
    ]);
    expect(main?.npcId).toBe('first');
    expect(rankCompanions([]).main).toBeNull();
  });

  it('C3: an affinity delta of +15 in one action is rejected, not trimmed', () => {
    const r = applyAffinityDelta(0, 15);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('out_of_range');
    expect(applyAffinityDelta(0, -11).ok).toBe(false);
    expect(applyAffinityDelta(0, 2.5).ok).toBe(false);
  });

  it('C3: +10 / -10 pass, and the result stays inside -100..100', () => {
    expect(applyAffinityDelta(0, 10)).toEqual({ ok: true, before: 0, delta: 10, after: 10 });
    expect(applyAffinityDelta(95, 10)).toEqual({ ok: true, before: 95, delta: 10, after: 100 });
    expect(applyAffinityDelta(-95, -10)).toEqual({ ok: true, before: -95, delta: -10, after: -100 });
  });

  it('C4: grade F at affinity 70 with good karma becomes SS ทูตสวรรค์', () => {
    expect(evolveNpc({ ...base, affinity: 70, karma: 40 })).toEqual({ grade: 'SS', form: 'angel' });
  });

  it('C4: grade F at affinity 70 with evil karma becomes SS เทพมารจันทราโลหิต', () => {
    expect(evolveNpc({ ...base, affinity: 70, karma: -40 })).toEqual({ grade: 'SS', form: 'blood-moon' });
  });

  it('C4: grade F at affinity 69 stays F; neutral karma (-39..39) stays F; only at the end of Night', () => {
    expect(evolveNpc({ ...base, affinity: 69, karma: 80 })).toBeNull();
    expect(evolveNpc({ ...base, affinity: 90, karma: 39 })).toBeNull();
    expect(evolveNpc({ ...base, affinity: 90, karma: -39 })).toBeNull();
    expect(evolveNpc({ ...base, affinity: 90, karma: 60, nightEnd: false })).toBeNull();
    // Only F takes this path.
    expect(evolveNpc({ ...base, grade: 'B', affinity: 100, karma: 100 })).toBeNull();
  });

  it('C5: a new NPC of grade SS is rejected; F / B / A / S may spawn', () => {
    expect(checkNpcSpawn('SS')?.code).toBe('grade_not_spawnable');
    expect(checkNpcSpawn('Z')?.code).toBe('grade_not_spawnable');
    for (const rank of ['F', 'B', 'A', 'S']) expect(checkNpcSpawn(rank)).toBeNull();
  });

  it('C6: grade A with the crisis-aid flag becomes S; without it stays A', () => {
    expect(evolveNpc({ ...base, grade: 'A', crisisAided: true, nightEnd: false })).toEqual({ grade: 'S', form: null });
    expect(evolveNpc({ ...base, grade: 'A', affinity: 100, karma: 100 })).toBeNull();
    // S and SS never evolve again.
    expect(evolveNpc({ ...base, grade: 'S', crisisAided: true })).toBeNull();
    expect(evolveNpc({ ...base, grade: 'SS', affinity: 100, karma: 100 })).toBeNull();
  });

  it('C6: crisis aid = DC 17 or more and a success / crit', () => {
    expect(isCrisisAid(17, 'success')).toBe(true);
    expect(isCrisisAid(20, 'crit')).toBe(true);
    expect(isCrisisAid(14, 'success')).toBe(false);
    expect(isCrisisAid(23, 'fail')).toBe(false);
    expect(isCrisisAid(null, 'success')).toBe(false);
  });

  it('C7: grade B cannot give a Legendary reward; Common and Rare are fine', () => {
    expect(checkNpcReward('B', 'Legendary')?.code).toBe('tier_not_allowed');
    expect(checkNpcReward('B', 'Common')).toBeNull();
    expect(checkNpcReward('B', 'Rare')).toBeNull();
  });

  it('C7: rewards by grade: F nothing, A / S Rare only, SS Legendary', () => {
    expect(checkNpcReward('F', 'Common')?.code).toBe('tier_not_allowed');
    expect(checkNpcReward('A', 'Rare')).toBeNull();
    expect(checkNpcReward('A', 'Legendary')?.code).toBe('tier_not_allowed');
    expect(checkNpcReward('S', 'Rare')).toBeNull();
    expect(checkNpcReward('SS', 'Legendary')).toBeNull();
  });

  it('Q-084: name reveal by grade: F +5, B +9, A +20, S +40, SS always', () => {
    expect([revealsNpcName('F', 4), revealsNpcName('F', 5)]).toEqual([false, true]);
    expect([revealsNpcName('B', 8), revealsNpcName('B', 9)]).toEqual([false, true]);
    expect([revealsNpcName('A', 19), revealsNpcName('A', 20)]).toEqual([false, true]);
    expect([revealsNpcName('S', 39), revealsNpcName('S', 40)]).toEqual([false, true]);
    expect(revealsNpcName('SS', -100)).toBe(true);
  });
});
