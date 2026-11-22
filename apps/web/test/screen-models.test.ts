import { RoomViewLockCode } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { describe, expect, it } from 'vitest';
import { bondBar, entrySection, lockTitle, rollLine, topBar } from '../src/screen-models.ts';

// GEN-099: the web reads the contract's fixtures through its own view-models (the mock layer of GEN-100 uses the same).
describe('screen view-models over the contract fixtures', () => {
  it('UI-I3: every entry kind goes to its section (feed → place, narration / whisper / omen → private, hit → pin)', () => {
    const sections = CONTRACT_FIXTURES.RoomEntry.map((e) => [e.kind, entrySection(e)]);
    expect(Object.fromEntries(sections)).toEqual({ feed: 'place', narration: 'private', whisper: 'private', omen: 'private', hit: 'pin' });
  });

  it('top bar: day, the current period with its turn dots, weather words and "ส่งแล้ว n/m" (none in Single)', () => {
    const [online] = CONTRACT_FIXTURES.RoomState;
    const bar = topBar(online as Parameters<typeof topBar>[0]);
    expect(bar.day).toBe('วันที่ 3/12');
    expect(bar.periods.map((p) => [p.phase, p.current, p.turns.join(',')])).toEqual([
      ['EOSORIA', false, 'done,done'],
      ['SOLARION', true, 'current,todo'],
      ['HESPERION', false, 'todo,todo'],
      ['NOCTHERION', false, 'todo,todo'],
    ]);
    expect(bar.weather).toBe('ฝนตก');
    expect(bar.submitted).toBe('ส่งแล้ว 3/3');
    const single = CONTRACT_FIXTURES.RoomState.find((s) => s.mode === 'single')!;
    expect(topBar(single as Parameters<typeof topBar>[0]).submitted).toBeNull();
  });

  it('F5 roll line and F4 bond bar are words / steps, no number but the d20 face', () => {
    expect(rollLine(CONTRACT_FIXTURES.RollView[0] as Parameters<typeof rollLine>[0])).toBe('ทอย d20 = 14 · ยาก · สำเร็จ');
    expect(bondBar({ word: 'สนิท', step: 5 })).toEqual([true, true, true, true, true, false]);
  });

  it('every lock code of the contract has a title', () => {
    for (const code of RoomViewLockCode.options) expect(lockTitle(code)).not.toBe('');
  });
});
