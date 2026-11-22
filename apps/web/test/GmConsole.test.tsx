import type { GmConsoleResponse, GmLogResponse } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmConsole } from '../src/GmConsole.tsx';

type Handler = (init: RequestInit | undefined) => Response;

function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && url.endsWith(p!);
    });
    if (!key) throw new Error(`unexpected request ${method} ${url}`);
    return routes[key]!(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (fetchMock: ReturnType<typeof stubApi>, method: string, path: string) =>
  fetchMock.mock.calls
    .filter(([input, init]) => String(input).endsWith(path) && (init?.method ?? 'GET') === method)
    .map(([, init]) => JSON.parse(String(init?.body ?? 'null')) as unknown);

const character = (memberId: string, name: string, karma: number) => ({
  memberId,
  ref: `p-${memberId}`,
  playerName: name,
  name,
  appearance: 'ผ้าคลุมเทา',
  personality: '',
  hp: { current: 100, max: 100 },
  stamina: { current: 30, max: 30 },
  injury: 'ปกติ' as const,
  socialTitle: 'คนแปลกหน้า',
  reputationScore: 0,
  karma,
  conduct: 'เป็นกลาง',
  locationId: 'market',
  knowsNamesOf: [],
  npcBonds: [],
  playerBonds: [],
});

function consoleView(pending: boolean): GmConsoleResponse {
  return {
    view: 'gm',
    at: { day: 1, phase: 'EOSORIA', turn: 1 },
    status: pending ? 'resolving' : 'collecting',
    characters: [character('m-a', 'ลิน', -30), character('m-b', 'ดาริน', 20)],
    evidence: [],
    actions: [{ memberId: 'm-b', day: 1, phase: 'EOSORIA', turn: 1, text: 'แอบล้วงกระเป๋าพ่อค้า', visibility: 'secret', rest: false }],
    events: [{ id: 'd1-bread', day: 1, phase: 'EOSORIA', title: 'ขนมปังแพง', status: 'active', outcome: null, outcomeSource: null }],
    legendaries: [{ id: 'dawn', name: 'พรแห่งแสงรุ่ง', type: 'skill', condition: 'ทำความดีต่อเนื่อง 10 วัน', counter: 'streak_days', target: 10, progress: 2, unlocked: false }],
    pending: pending
      ? {
          at: { day: 1, phase: 'EOSORIA', turn: 1 },
          entries: [
            { index: 0, kind: 'feed', memberId: null, locationId: 'market', text: 'มีคนที่นี่ลงมือทำบางอย่าง', edited: false },
            { index: 1, kind: 'narration', memberId: 'm-a', locationId: null, text: 'ฉบับเดิมของลิน', edited: false },
          ],
          results: [{ memberId: 'm-a', before: { hp: 100, stamina: 30, karma: -30 }, after: { hp: 90, stamina: 30, karma: -30 }, edited: false }],
        }
      : null,
  };
}

const emptyLog: GmLogResponse = { overrides: [] };

describe('GEN-058 GM console (web)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('C1: shows every karma, the Secret actions and the Legendary conditions', async () => {
    stubApi({ 'GET /api/game/gm/console': () => Response.json(consoleView(false)), 'GET /api/game/gm/log': () => Response.json(emptyLog) });
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const people = await screen.findByRole('region', { name: 'ตัวละครทั้งหมด' });
    expect(within(people).getByText(/ลิน.*Karma -30/)).toBeTruthy();
    expect(within(people).getByText(/ดาริน.*Karma 20/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'action ทั้งหมด' })).getByText(/Secret.*แอบล้วงกระเป๋าพ่อค้า/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'เงื่อนไข Legendary' })).getByText(/ทำความดีต่อเนื่อง 10 วัน/)).toBeTruthy();
    expect(screen.getByText('ยังไม่มีผลของเทิร์นที่รออนุมัติ')).toBeTruthy();
  });

  it('C2: edits the held narration and HP with a reason, then approves', async () => {
    let held = true;
    const fetchMock = stubApi({
      'GET /api/game/gm/console': () => Response.json(consoleView(held)),
      'GET /api/game/gm/log': () => Response.json(emptyLog),
      'POST /api/game/gm/turn/edit': () => Response.json(consoleView(true).pending),
      'POST /api/game/gm/turn/approve': () => {
        held = false;
        return Response.json({ approved: { day: 1, phase: 'EOSORIA', turn: 1 } });
      },
    });
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const turn = await screen.findByRole('region', { name: 'ผลของเทิร์นที่รออนุมัติ' });
    fireEvent.change(within(turn).getByLabelText(/ข้อความ 2/), { target: { value: 'ฉบับที่ GM แก้' } });
    fireEvent.change(within(turn).getByLabelText('HP ของ ลิน'), { target: { value: '80' } });
    fireEvent.change(within(turn).getByLabelText('เหตุผลของการแก้'), { target: { value: 'ให้เชื่อมกับไฟไหม้' } });
    fireEvent.click(within(turn).getByRole('button', { name: 'บันทึกการแก้' }));
    await waitFor(() => expect(bodyOf(fetchMock, 'POST', '/api/game/gm/turn/edit')).toHaveLength(1));
    expect(bodyOf(fetchMock, 'POST', '/api/game/gm/turn/edit')[0]).toEqual({
      reason: 'ให้เชื่อมกับไฟไหม้',
      narrations: [{ index: 1, text: 'ฉบับที่ GM แก้' }],
      results: [{ memberId: 'm-a', hp: 80 }],
    });
    fireEvent.click(within(turn).getByRole('button', { name: 'อนุมัติและส่งให้ผู้เล่น' }));
    await waitFor(() => expect(bodyOf(fetchMock, 'POST', '/api/game/gm/turn/approve')).toHaveLength(1));
    expect(await screen.findByText('ยังไม่มีผลของเทิร์นที่รออนุมัติ')).toBeTruthy();
  });

  it('C3: shows the Thai reason when the server refuses a value', async () => {
    stubApi({
      'GET /api/game/gm/console': () => Response.json(consoleView(false)),
      'GET /api/game/gm/log': () => Response.json(emptyLog),
      'POST /api/game/gm/adjust': () =>
        Response.json({ code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { value: 'HP ต้องเป็นจำนวนเต็ม 1 ถึง 100 ตามกฎ' } }, { status: 400 }),
    });
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const form = await screen.findByRole('form', { name: 'ปรับค่าด้วยมือ' });
    fireEvent.change(within(form).getByLabelText('ตัวละคร'), { target: { value: 'm-a' } });
    fireEvent.change(within(form).getByLabelText('ค่า'), { target: { value: 'hp' } });
    fireEvent.change(within(form).getByLabelText('ค่าใหม่'), { target: { value: '150' } });
    fireEvent.change(within(form).getByLabelText('เหตุผล'), { target: { value: 'ทดสอบ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'ปรับค่า' }));
    expect(await within(form).findByRole('alert')).toHaveProperty('textContent', 'HP ต้องเป็นจำนวนเต็ม 1 ถึง 100 ตามกฎ');
  });

  it('Q-174: choosing affinity shows a short Thai warning that a hand edit does not reveal, reward or evolve', async () => {
    stubApi({ 'GET /api/game/gm/console': () => Response.json(consoleView(false)), 'GET /api/game/gm/log': () => Response.json(emptyLog) });
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const form = await screen.findByRole('form', { name: 'ปรับค่าด้วยมือ' });
    expect(within(form).queryByRole('note')).toBeNull();
    fireEvent.change(within(form).getByLabelText('ค่า'), { target: { value: 'affinity' } });
    const note = within(form).getByRole('note');
    expect(note.textContent).toMatch(/ไม่เปิดเผยชื่อ/);
    expect(note.textContent).toMatch(/\+9/);
    expect(note.textContent).toMatch(/วิวัฒนาการ/);
    expect(note.textContent).toMatch(/ครั้งถัดไป/);
    fireEvent.change(within(form).getByLabelText('ค่า'), { target: { value: 'karma' } });
    expect(within(form).queryByRole('note')).toBeNull();
  });

  it('Q-176: an approve row reads as approved, with or without edits', async () => {
    const row = (id: number, edits: number) => ({
      id, gmMemberId: 'm-gm', gmName: 'จีเอ็ม', kind: 'approve' as const, at: { day: 1, phase: 'EOSORIA' as const, turn: 1 as const },
      target: 'turn', before: null, after: { edits }, reason: '', createdAt: 0,
    });
    stubApi({ 'GET /api/game/gm/console': () => Response.json(consoleView(false)), 'GET /api/game/gm/log': () => Response.json({ overrides: [row(1, 0), row(2, 3)] }) });
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const logView = await screen.findByRole('region', { name: 'บันทึกการแก้ของ GM' });
    expect(await within(logView).findByText(/จีเอ็ม.*อนุมัติผลของเทิร์นตามที่ AI GM เขียน/)).toBeTruthy();
    expect(within(logView).getByText(/จีเอ็ม.*อนุมัติผลของเทิร์น \(แก้ 3 จุด\)/)).toBeTruthy();
  });

  it('C4 + C5: inserts an event with a reason; the log shows who changed what and why', async () => {
    let log: GmLogResponse = emptyLog;
    const fetchMock = stubApi({
      'GET /api/game/gm/console': () => Response.json(consoleView(false)),
      'GET /api/game/gm/log': () => Response.json(log),
      'POST /api/game/gm/events': () => {
        log = {
          overrides: [
            {
              id: 1,
              gmMemberId: 'm-gm',
              gmName: 'จีเอ็ม',
              kind: 'event',
              at: { day: 1, phase: 'EOSORIA', turn: 1 },
              target: 'event:gm-1',
              before: null,
              after: { day: 6, phase: 'SOLARION', title: 'ไฟไหม้ตลาด' },
              reason: 'เพิ่มแรงกดดัน',
              createdAt: 0,
            },
          ],
        };
        return Response.json({ event: { id: 'gm-1', day: 6, phase: 'SOLARION', title: 'ไฟไหม้ตลาด', status: 'pending', outcome: null, outcomeSource: null } });
      },
    });
    render(<GmConsole apiBaseUrl="http://api" token="tok" refreshKey="1" />);
    const form = await screen.findByRole('form', { name: 'แทรกเหตุการณ์' });
    fireEvent.change(within(form).getByLabelText('วันที่'), { target: { value: '6' } });
    fireEvent.change(within(form).getByLabelText('ช่วงเวลา'), { target: { value: 'SOLARION' } });
    fireEvent.change(within(form).getByLabelText('ชื่อเหตุการณ์'), { target: { value: 'ไฟไหม้ตลาด' } });
    fireEvent.change(within(form).getByLabelText('เหตุผล'), { target: { value: 'เพิ่มแรงกดดัน' } });
    fireEvent.click(within(form).getByRole('button', { name: 'แทรกเหตุการณ์' }));
    await waitFor(() => expect(bodyOf(fetchMock, 'POST', '/api/game/gm/events')).toHaveLength(1));
    expect(bodyOf(fetchMock, 'POST', '/api/game/gm/events')[0]).toMatchObject({ day: 6, phase: 'SOLARION', title: 'ไฟไหม้ตลาด', reason: 'เพิ่มแรงกดดัน' });
    const logView = screen.getByRole('region', { name: 'บันทึกการแก้ของ GM' });
    expect(await within(logView).findByText(/จีเอ็ม.*event:gm-1.*เพิ่มแรงกดดัน/)).toBeTruthy();
  });
});
