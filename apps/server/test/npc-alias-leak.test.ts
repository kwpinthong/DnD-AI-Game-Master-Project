import { defaultScenario } from '@isekai/protocol';
import { describe, expect, it } from 'vitest';
import { loadGameAssets } from '../src/assets/load.ts';
import { sheetNpcFor } from '../src/companions/sheet.ts';

/** GEN-121 C9 (Q-303): an NPC's outward look (alias / Public_Alias) never contains a name it has. */
describe('NPC aliases carry no real name (GEN-121)', () => {
  const assets = loadGameAssets();

  it('C9: no scenario NPC alias (nor the sheet alias it maps to) contains its name or otherNames', () => {
    for (const npc of defaultScenario().npcs) {
      const names = [npc.name, ...(npc.otherNames ?? [])].filter((n) => n.length > 1);
      const sheet = sheetNpcFor(assets, npc);
      const shown = [npc.alias, ...(sheet ? [sheet.hiddenName] : [])];
      const sheetNames = sheet ? [sheet.realName, ...sheet.record.aliases.filter((a) => a.length > 2 && a !== sheet.record.publicAlias)] : [];
      for (const look of shown) {
        for (const name of [...names, ...sheetNames]) {
          // A sheet alias may be a long form of the name cell: only the look itself must not hold a name.
          if (look === name) continue;
          expect(look.includes(name), `${npc.id}: alias "${look}" contains "${name}"`).toBe(false);
        }
      }
    }
  });

  it('C9: no sheet NPC Public_Alias contains a name from its row', () => {
    for (const record of assets.npcs) {
      const names = record.aliases.filter((a) => a.length > 2 && a !== record.publicAlias);
      for (const name of names) expect(record.publicAlias.includes(name), `${record.aliases[0]}: "${record.publicAlias}" contains "${name}"`).toBe(false);
    }
  });
});
