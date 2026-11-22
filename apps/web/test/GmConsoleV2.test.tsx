// GEN-091: the GM console on theme v2, on the GEN-099 fixture. C1 every number a player never gets,
// Q-215 the finale label, Q-252 curses on players and NPCs, Q-221 the budget status, C5 the phone note.
import { GmConsoleResponse, type RoomGmStatus } from '@isekai/protocol';
import { CONTRACT_FIXTURES } from '@isekai/protocol/contract';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmConsole } from '../src/GmConsole.tsx';

const FIXTURE = GmConsoleResponse.parse(CONTRACT_FIXTURES.GmConsoleResponse[0]);
const FINALE = CONTRACT_FIXTURES.GmPendingTurn.find((t) => t.finale)!;

function stubConsole(view: GmConsoleResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/game/gm/console')) return Response.json(view);
      if (url.endsWith('/api/game/gm/log')) return Response.json(CONTRACT_FIXTURES.GmLogResponse[0]);
      throw new Error(`unexpected request ${url}`);
    }),
  );
}

async function open(view: GmConsoleResponse, gmStatus?: RoomGmStatus) {
  stubConsole(view);
  render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" {...(gmStatus ? { gmStatus } : {})} />);
  await screen.findByRole('region', { name: 'ตัวละครทั้งหมด' });
}

describe('GEN-091 GM console v2', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('C1: the fixture console shows karma, reputation, affinity and DC as numbers', async () => {
    await open(FIXTURE);
    const people = within(screen.getByRole('region', { name: 'ตัวละครทั้งหมด' }));
    expect(people.getByText(/ลิน.*Karma 3/)).toBeTruthy();
    expect(people.getByText(/ชื่อเสียง 14/)).toBeTruthy();
    expect(people.getByText(/HP 22\/30/)).toBeTruthy();

    const npcs = within(screen.getByRole('region', { name: 'NPC และค่าความสัมพันธ์' }));
    expect(npcs.getByText(/ลิน \+52/)).toBeTruthy();

    const turn = within(screen.getByRole('region', { name: 'ผลของเทิร์นที่รออนุมัติ' }));
    const check = turn.getByRole('listitem', { name: /ตามนักบวช/ });
    expect(check.textContent).toContain('DC 14');
    expect(check.textContent).toContain('d20 14');
    expect(check.textContent).toContain('รวม 17');
    expect(check.textContent).toContain('Glare of Truth +2');
    expect(check.textContent).toContain('OBSERVE');
  });

  it('Q-252: curses on a player and on an NPC show their d20 change and the turns left', async () => {
    await open(FIXTURE);
    expect(within(screen.getByRole('region', { name: 'ตัวละครทั้งหมด' })).getByText(/หวาดกลัว \(Venom of Despair\) d20 -3 อีก 2 เทิร์น/)).toBeTruthy();
    const npcs = within(screen.getByRole('region', { name: 'NPC และค่าความสัมพันธ์' }));
    expect(npcs.getByText(/พ่อค้าเร่/)).toBeTruthy();
    expect(npcs.getByText(/มึนงง \(Mist of Confusion\) d20 -2 อีก 1 เทิร์น/)).toBeTruthy();
    expect(npcs.queryByText(/รอ backend/)).toBeNull();
  });

  it('Q-252: without `npcs` (the backend does not send it yet) it says the NPC curses are pending', async () => {
    const { npcs: _npcs, ...withoutNpcs } = FIXTURE;
    await open(withoutNpcs);
    const npcs = within(screen.getByRole('region', { name: 'NPC และค่าความสัมพันธ์' }));
    expect(npcs.getByText(/คำสาปบน NPC.*รอ backend/)).toBeTruthy();
    // affinity still comes from the characters
    expect(npcs.getByText(/ลิน \+52/)).toBeTruthy();
  });

  it('Q-215: a held finale has its own label and only the narration can be edited', async () => {
    await open({ ...FIXTURE, pending: GmConsoleResponse.shape.pending.parse(FINALE) });
    const finale = within(screen.getByRole('region', { name: 'ตอนจบที่รออนุมัติ' }));
    expect(finale.getByRole('heading', { name: /ตอนจบที่รออนุมัติ/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'ผลของเทิร์นที่รออนุมัติ' })).toBeNull();
    expect(finale.getByLabelText(/ข้อความ 1/)).toBeTruthy();
    expect(finale.queryByRole('spinbutton')).toBeNull();
    expect(finale.getByRole('button', { name: 'อนุมัติและส่งให้ผู้เล่น' })).toBeTruthy();
  });

  it('Q-221: budget_reached shows the server reason on the console; no status = no banner', async () => {
    await open(FIXTURE, { code: 'budget_reached', message: 'ใช้ครบงบ AI ของเดือนนี้แล้ว AI GM หยุดจนกว่าจะปรับเพดาน', canRetry: false });
    const banner = screen.getByRole('status', { name: 'สถานะ AI GM' });
    expect(banner.textContent).toContain('ถึงเพดานงบ AI');
    expect(banner.textContent).toContain('ใช้ครบงบ AI ของเดือนนี้แล้ว');
    cleanup();
    await open(FIXTURE);
    expect(screen.queryByRole('status', { name: 'สถานะ AI GM' })).toBeNull();
  });

  it('C5 + Q-200: carries the phone note, and its buttons are the theme <Button>', async () => {
    await open(FIXTURE);
    expect(screen.getByRole('note', { name: 'คำแนะนำสำหรับมือถือ' }).textContent).toMatch(/จอคอมพิวเตอร์/);
    expect(screen.getByRole('button', { name: 'อนุมัติและส่งให้ผู้เล่น' }).className).toContain('btn--primary');
    expect(screen.getByRole('button', { name: 'ปรับค่า' }).className).toContain('btn');
  });
});
