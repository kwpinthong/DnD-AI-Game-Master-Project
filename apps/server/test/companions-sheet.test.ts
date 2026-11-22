import { describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import { EVOLUTION_RULES } from '../src/companions/evolution-rules.ts';
import { sheetNpcs } from '../src/companions/sheet.ts';

/** The NPC tab in apps/server/assets/npc.json read as companion data (GEN-054). */
describe('companion data from the sheet NPC tab (GEN-054)', () => {
  const assets = loadGameAssets();
  const catalog = sheetNpcs(assets);

  it('every grade F / A / S NPC has an evolution rule and every rule belongs to a sheet NPC', () => {
    const needRule = assets.npcs.filter((n) => n.grade !== 'B').map((n) => n.aliases[0]);
    expect(Object.keys(EVOLUTION_RULES).sort()).toEqual([...needRule].sort());
  });

  it('every number in a rule is written in that NPC Evolution / Unlock Condition', () => {
    for (const [key, rule] of Object.entries(EVOLUTION_RULES)) {
      const text = assets.npc(key)!.unlockCondition;
      const numbers = rule.paths.flatMap((p) =>
        p.all.flatMap((c) => {
          switch (c.type) {
            case 'affinity':
              return [c.min];
            case 'karma':
              // "ต่ำกว่า -50" is written as max -51.
              return [c.min, c.max === undefined ? undefined : text.includes(`ต่ำกว่า ${c.max + 1}`) ? c.max + 1 : c.max];
            case 'flag':
              return [c.count, c.day, c.minDay];
            case 'activityStreak':
              return [c.fromDay, c.days, c.periodsPerDay, c.karmaMin, c.karmaMax];
            case 'karmaBandThrough':
              return [c.min, c.max, c.untilDay];
          }
        }),
      );
      for (const n of numbers) {
        if (n === undefined) continue;
        const written = n > 0 && text.includes(`+${n}`) ? `+${n}` : String(n);
        expect(text, `${key}: ${n}`).toContain(written);
      }
    }
  });

  it('the evolved names come from the true-name cell, one per path', () => {
    const noa = catalog.get('โนอา')!;
    expect(noa.evolvedName('Good')).toBe('Seraphiel, Herald of Dawn');
    expect(noa.evolvedName('Evil')).toBe('Malakor, Blood Moon Incarnate');
    expect(catalog.get('ลูเซีย')!.evolvedName('Neutral')).toBe('Chronos-Zero, The Unbound Arbiter');
    expect(catalog.get('ลอร์ดจูเลียน แวนเดอร์บิลต์')!.evolvedName(null)).toBe('ลอร์ดจูเลียน ผู้พิทักษ์พันธสัญญา');
    expect(catalog.get('ออเรเลีย')!.evolvedName(null)).toBe('ออเรเลีย');
  });

  it('grade B: the alias, the real name and the reveal affinity come from the cells', () => {
    const elena = catalog.get('แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า')!;
    expect([elena.hiddenName, elena.realName, elena.revealAffinity]).toEqual(['แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า', 'ซิสเตอร์เอเลน่า', 9]);
    for (const n of catalog.values()) if (n.grade === 'B') expect(n.revealAffinity).toBe(9);
  });

  it('every reward in the Rewards & Abilities cells is an Ability or an Item of the sheet', () => {
    const stagesOf = (key: string) => catalog.get(key)!.rewards.map((s) => [s.stage, s.alignment, s.rewards.map((r) => `${r.kind}:${r.name}`)]);
    expect(stagesOf('โนอา')).toEqual([
      ['evolved', 'Good', ['skill:The First Light', 'item:Chalice of the First Dawn']],
      ['evolved', 'Evil', ['skill:ORDO TENEBRIS', 'item:Grimoire of the Blood Moon']],
    ]);
    expect(stagesOf('แม่ชีผู้เหนื่อยล้าแห่งโบสถ์เก่า')).toEqual([
      ['reveal', null, ['item:Blessed Loaf of Dawn', 'item:Silver Rosary of Hearth']],
      ['quest', null, ['item:Prism of Truth']],
    ]);
    expect(stagesOf('ลอร์ดจูเลียน แวนเดอร์บิลต์')).toEqual([
      ['base', null, ['item:Censer of Purging Flame']],
      ['evolved', null, ['skill:Sanctuary Aegis']],
    ]);
    expect(stagesOf('แอสทรา')).toEqual([['evolved', null, ['skill:Absolute Zero Law']]]);
    for (const n of catalog.values()) {
      expect(n.rewards.length, n.key).toBeGreaterThan(0);
      for (const s of n.rewards) expect(s.rewards.length, `${n.key} ${s.stage}`).toBeGreaterThan(0);
    }
  });
});
