import { describe, expect, it } from 'vitest';
import type { GameAssets } from '../src/assets/load.ts';
import type { GmWorld } from '../src/gm/context.ts';
import { lingerNow, npcsPresentAt, type Linger } from '../src/gm/npc-lines.ts';
import { periodAnnouncement, sceneNpcs } from '../src/gm/scene.ts';
import { loadGameAssets } from '../src/assets/load.ts';

/** GEN-145: the period-change scene: the server's time announcement and who the scene of a place lists. */

describe('GEN-145 the scene of a place lists the NPCs who arrived, left and stay', () => {
  const world = {
    places: [
      { id: 'fountain', name: 'น้ำพุกลางเมือง' },
      { id: 'temple', name: 'โบสถ์' },
    ],
    npcs: [
      { id: 'malcolm', names: ['มัลคอล์ม'], alias: 'นักบวช', locationId: 'temple' },
      { id: 'lucia', names: ['ลูเซีย'], alias: 'หญิงสาว', locationId: 'temple' },
      { id: 'noah', names: ['โนอา'], alias: 'เด็กขอทาน', locationId: 'temple' },
      { id: 'merchant', names: ['มาร์คัส'], alias: 'พ่อค้า', locationId: 'fountain' },
    ],
  } as unknown as GmWorld;
  const row = (npc: string, location: string, periods: string[]) => ({ npc, location, periods, weathers: [], condition: '', note: '' });
  // EOSORIA: Malcolm and Noah at the fountain. SOLARION: Lucia at the fountain, Malcolm and Noah at the temple.
  const assets = {
    npcSchedule: [
      row('มัลคอล์ม', 'น้ำพุกลางเมือง', ['EOSORIA']),
      row('มัลคอล์ม', 'โบสถ์', ['SOLARION']),
      row('โนอา', 'น้ำพุกลางเมือง', ['EOSORIA']),
      row('โนอา', 'โบสถ์', ['SOLARION']),
      row('ลูเซีย', 'น้ำพุกลางเมือง', ['SOLARION']),
    ],
  } as unknown as GameAssets;

  it('C3: new (Lucia), leaving (Malcolm) and staying past the schedule (Noah, talked to last turn); one with no schedule row is none of them', () => {
    const last: Linger[] = [{ npcId: 'noah', placeId: 'fountain', used: 0, talked: true }];
    const solarion = { phase: 'SOLARION' as const, weather: null, karmas: [] };
    const { lingering } = lingerNow(last, (npcId, placeId) => npcsPresentAt(world, assets, placeId, solarion).some((n) => n.id === npcId));
    const groups = sceneNpcs(world, assets, 'fountain', { phase: 'EOSORIA', weather: null, karmas: [], lingering: last }, { ...solarion, lingering });
    const ids = (list: { id: string }[]) => list.map((n) => n.id);
    expect(ids(groups.arrived)).toEqual(['lucia']);
    expect(ids(groups.left)).toEqual(['malcolm']);
    expect(ids(groups.lingering)).toEqual(['noah']);
    // Only the alias goes to the AI, never a real name.
    expect(JSON.stringify(groups)).not.toMatch(/มัลคอล์ม|ลูเซีย|โนอา/);
    expect(groups.arrived[0]).toEqual({ id: 'lucia', alias: 'หญิงสาว' });
  });

  it('C3: the temple sees Malcolm and Noah arrive... except Noah, who stays at the fountain', () => {
    const last: Linger[] = [{ npcId: 'noah', placeId: 'fountain', used: 0, talked: true }];
    const solarion = { phase: 'SOLARION' as const, weather: null, karmas: [] };
    const { lingering } = lingerNow(last, (npcId, placeId) => npcsPresentAt(world, assets, placeId, solarion).some((n) => n.id === npcId));
    const groups = sceneNpcs(world, assets, 'temple', { phase: 'EOSORIA', weather: null, karmas: [], lingering: last }, { ...solarion, lingering });
    expect(groups.arrived.map((n) => n.id)).toEqual(['malcolm']);
    expect(groups.left.map((n) => n.id)).toEqual(['lucia']);
    expect(groups.lingering).toEqual([]);
  });
});

describe('GEN-145 the time announcement (GEN-150 time_announce, no AI)', () => {
  const assets = loadGameAssets();

  it('C1: names the new period with its hours', () => {
    const text = periodAnnouncement(assets, { day: 1, phase: 'HESPERION' }, { day: 1, phase: 'SOLARION' });
    expect(text).toContain('HESPERION');
    expect(text).toContain('ค่ำ 18:00-23:59');
    expect(text).not.toContain('{phase}');
    expect(text).not.toContain('วันที่');
  });

  it('C5: a new day names the day', () => {
    const text = periodAnnouncement(assets, { day: 2, phase: 'EOSORIA' }, { day: 1, phase: 'NOCTHERION' });
    expect(text).toContain('วันที่ 2');
    expect(text).toContain('EOSORIA');
  });
});
