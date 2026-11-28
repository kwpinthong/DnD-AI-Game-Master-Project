// ISK-026 C13: the arrival paragraph (ISK-009) comes in the reader's own narration entry, after the action results
// (each cut to 120 by the server); the feed draws it whole, live and from a reload (history), with no web change.
import type { RoomEntry } from '@isekai/protocol';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFeed } from '../src/play/chat/ChatFeed.tsx';

const at = { day: 1, phase: 'SOLARION', turn: 1 } as const;
const ACTION = 'คุณเดินฝ่าฝูงคนมาถึงขอบน้ำพุ ละอองน้ำเย็นกระทบแก้มจนต้องหยีตา';
const ARRIVAL =
  'จัตุรัสกลางเมืองยามสายสว่างจ้า น้ำพุหินเก่าพ่นละอองเป็นประกายรุ้งบางๆ เด็กขอทานตาบอดข้างหนึ่งนั่งขดตัวอยู่ริมขอบน้ำ ส่วนหญิงสาวผู้พกนาฬิกาพกตายยืนนิ่งมองเข็มที่ไม่ขยับ พ่อค้าเร่ตะโกนขายขนมปังแข่งกับเสียงนกพิราบ';
const entry: RoomEntry = { seq: 7, kind: 'narration', ...at, place: null, text: `${ACTION}\n${ARRIVAL}` };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const feed = (live: ReadonlyMap<number, number>) => render(<ChatFeed entries={[entry]} placeId="fountain" placeName="น้ำพุกลางเมือง" astral={false} live={live} />);

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ISK-026 the arrival paragraph in the feed', () => {
  it('ISK-026 C13: live, once the reveal ends, the arrival paragraph is drawn whole after the action result', () => {
    expect([...ARRIVAL].length).toBeGreaterThan(120);
    const { container } = feed(new Map([[entry.seq, 0]]));
    act(() => vi.advanceTimersByTime(60_000));
    const shown = norm(container.textContent ?? '');
    expect(shown).toContain(norm(ARRIVAL));
    expect(shown.indexOf(norm(ACTION))).toBeLessThan(shown.indexOf(norm(ARRIVAL)));
  });

  it('ISK-026 C13: after a reload (history, not live) the arrival paragraph is drawn whole at once', () => {
    const { container } = feed(new Map());
    expect(norm(container.textContent ?? '')).toContain(norm(ARRIVAL));
  });
});
