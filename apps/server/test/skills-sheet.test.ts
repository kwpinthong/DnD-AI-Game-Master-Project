import { describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import { END_OF_PERIOD_WHEN } from '../src/skills/progress.ts';
import { SKILL_FLAGS, UNLOCK_RULES } from '../src/skills/unlock-rules.ts';

/** The Ability / Item tabs in apps/server/assets read as unlock rules (GEN-055). */
describe('unlock rules from the sheet (GEN-055)', () => {
  const assets = loadGameAssets();

  it('every Ability row has a rule and every rule is an Ability row', () => {
    expect(Object.keys(UNLOCK_RULES).sort()).toEqual(assets.abilities.map((a) => a.name).sort());
  });

  it('a path from an item needs that item held, and the item\'s Skill Synergy names the skill', () => {
    for (const [name, rule] of Object.entries(UNLOCK_RULES)) {
      for (const path of rule.paths.filter((p) => p.source !== 'condition')) {
        const item = path.source.replace(/^item:/, '');
        expect(assets.item(item), `${name}: ${path.source}`).toBeDefined();
        expect(path.all).toContainEqual({ type: 'holding', item });
        expect(assets.item(item)!.synergy, `${name}: ${path.source}`).toContain(name);
      }
    }
  });

  it('every skill and number of a rule is written in its row (Condition, or the item\'s Skill Synergy)', () => {
    for (const [name, rule] of Object.entries(UNLOCK_RULES)) {
      for (const path of rule.paths) {
        const text = path.source === 'condition' ? assets.ability(name)!.condition : assets.item(path.source.slice('item:'.length))!.synergy;
        for (const c of path.all) {
          if (c.type === 'skill') {
            expect(text, `${name}`).toContain(c.name);
            expect(assets.ability(c.name), c.name).toBeDefined();
          }
          if (c.type === 'skillOf') expect(text).toContain(`Rank ${c.rank} สาย ${c.alignment}`);
        }
        const numbers = path.all.flatMap((c) => {
          switch (c.type) {
            case 'karma': {
              // "ต่ำกว่า -60" / "น้อยกว่า -90" are written as max -61 / -91.
              const below = c.max !== undefined && (text.includes(`ต่ำกว่า ${c.max + 1}`) || text.includes(`น้อยกว่า ${c.max + 1}`));
              return [c.min, c.max === undefined ? undefined : below ? c.max + 1 : c.max];
            }
            case 'flag':
              return [c.count];
            case 'periods':
              return [c.count];
            case 'periodRun':
              return [c.periods];
            case 'streak':
              return [c.days, c.periodsPerDay, c.fromDay, c.karmaMin, c.karmaMax];
            case 'karmaDays':
              return [c.min, c.max, c.days];
            default:
              return [];
          }
        });
        for (const n of numbers) {
          if (n === undefined || n === 1) continue;
          const written = n > 0 && text.includes(`+${n}`) ? `+${n}` : String(n);
          expect(text, `${name} (${path.source}): ${n}`).toContain(written);
        }
      }
    }
  });

  it('flag names are snake_case', () => {
    for (const f of SKILL_FLAGS) expect(f).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('every end_of_period effect of the data has its condition', () => {
    const sources = [
      ...assets.abilities.filter((a) => a.effects.some((e) => e.duration.unit === 'end_of_period')).map((a) => a.name),
      ...assets.items.filter((i) => i.effects.some((e) => e.duration.unit === 'end_of_period')).map((i) => i.nameEn),
    ];
    expect(Object.keys(END_OF_PERIOD_WHEN).sort()).toEqual(sources.sort());
  });
});
