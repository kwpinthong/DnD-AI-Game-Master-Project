// GEN-046 scenario editor. ISK-019: it is a step of the create-game form (the Human GM's game) and its scenario goes
// in POST /api/games; in the lobby the GM only reads it.
import { defaultScenario, type GameView, type Scenario } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { CreateGameForm } from '../src/CreateGameForm.tsx';
import { TOKEN_KEY } from '../src/session.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Routes are "METHOD /path"; the first matching suffix wins. */
function stubApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return Response.json({ ok: true, db: 'connected' });
    const method = init?.method ?? 'GET';
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && url.endsWith(p!);
    });
    if (!key) throw new Error(`unexpected request ${method} ${url}`);
    return routes[key]!(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof stubApi>, method: string, path: string) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith(path) && (init?.method ?? 'GET') === method);

const gm = { id: 'm-gm', gameId: 'g-1', name: 'ต้น' };

function view(patch: Partial<GameView> = {}): GameView {
  return {
    id: 'g-1',
    name: 'ห้องทดสอบ',
    mode: 'online',
    humanGm: true,
    inviteCode: 'K7Q2MX',
    status: 'lobby',
    startedAt: null,
    you: { memberId: gm.id, role: 'gm' },
    members: [{ id: gm.id, name: gm.name, role: 'gm', ready: false, hasCharacter: false }],
    players: { count: 0, min: 2, max: 6 },
    canEditScenario: true,
    startBlockers: [],
    ...patch,
  };
}

const created = { token: 'tok-new', expiresAt: '2026-12-22T12:00:00.000Z', member: gm, game: view() };

/** The create form of a Human GM game with the scenario step open; POST /api/games answered by `answer`. */
async function openEditor(answer: Handler = () => Response.json(created)) {
  const fetchMock = stubApi({ 'POST /api/games': answer });
  render(<CreateGameForm apiBaseUrl="" onCreated={() => {}} onBack={() => {}} />);
  for (const [label, value] of [['Create code', 'ลับเฉพาะ'], ['ชื่อเกม', 'ห้องทดสอบ'], ['ชื่อผู้เล่นของคุณ', 'ต้น'], ['PIN ของคุณ', '1234']] as const) {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }
  fireEvent.click(screen.getByLabelText(/มี GM คน/));
  fireEvent.click(screen.getByRole('button', { name: 'แก้ scenario' }));
  await screen.findByRole('region', { name: 'แก้ scenario' });
  return fetchMock;
}

/** Back to the form and create the game: the scenario that was sent. */
async function create(fetchMock: ReturnType<typeof stubApi>): Promise<Scenario> {
  fireEvent.click(screen.getByRole('button', { name: 'กลับไปฟอร์ม' }));
  fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมและรับโค้ด' }));
  await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/games')).toHaveLength(1));
  return (JSON.parse(String((callsTo(fetchMock, 'POST', '/api/games')[0]![1] as RequestInit).body)) as { scenario: Scenario }).scenario;
}

const refused = (fields: Record<string, string>) => () => Response.json({ code: 'invalid_input', message: 'scenario ไม่ถูกต้อง', fields }, { status: 400 });
/** Create, get refused, and the step opens again with the messages. */
async function createRefused(fetchMock: ReturnType<typeof stubApi>) {
  fireEvent.click(screen.getByRole('button', { name: 'กลับไปฟอร์ม' }));
  fireEvent.click(screen.getByRole('button', { name: 'สร้างเกมและรับโค้ด' }));
  await screen.findByRole('region', { name: 'แก้ scenario' });
  expect(callsTo(fetchMock, 'POST', '/api/games')).toHaveLength(1);
}

const events = () => screen.getAllByRole('group', { name: /^เหตุการณ์ / });

/** Logged in as the GM of a created game (the lobby reads the scenario). */
function loggedIn(game: GameView) {
  localStorage.setItem(TOKEN_KEY, 'tok-gm');
  return stubApi({
    'GET /api/me': () => Response.json({ member: { id: gm.id, gameId: game.id, name: gm.name } }),
    'GET /api/game/scenario': () => Response.json({ scenario: defaultScenario(), locked: game.status === 'started' }),
    'GET /api/game': () => Response.json(game),
  });
}

describe('Scenario editor (GEN-046, ISK-019 at creation)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('C1: the GM adds an event on day 4 afternoon and it goes in the create request', async () => {
    const fetchMock = await openEditor();
    const before = events().length;

    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มเหตุการณ์' }));
    const added = events()[before]!;
    fireEvent.change(within(added).getByLabelText('วัน'), { target: { value: '4' } });
    fireEvent.change(within(added).getByLabelText('ช่วง'), { target: { value: 'NOCTHERION' } });
    fireEvent.change(within(added).getByLabelText('หัวข้อ'), { target: { value: 'คาราวานมาถึง' } });
    fireEvent.change(within(added).getByLabelText('ผลถ้าไม่มีใครแทรกแซง'), { target: { value: 'ถูกปล้นตอนค่ำ' } });

    const sent = await create(fetchMock);
    expect(sent.timeline.at(-1)).toMatchObject({ day: 4, phase: 'NOCTHERION', title: 'คาราวานมาถึง', outcome: 'ถูกปล้นตอนค่ำ' });
    expect(sent.timeline.at(-1)!.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('C1: the GM edits the Legendary condition and an NPC secret note', async () => {
    const fetchMock = await openEditor();

    fireEvent.click(screen.getByRole('button', { name: 'ตำนานลับ' }));
    const legendary = screen.getAllByRole('group', { name: /^ตำนาน / })[0]!;
    fireEvent.change(within(legendary).getByLabelText('เงื่อนไขลับ'), { target: { value: 'ช่วยเด็กกำพร้า 3 วันติด' } });
    fireEvent.change(within(legendary).getByLabelText('เป้า'), { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: 'NPC' }));
    const npc = screen.getAllByRole('group', { name: /^NPC / })[0]!;
    fireEvent.change(within(npc).getByLabelText('โน้ตลับของ GM'), { target: { value: 'เป็นสายลับ' } });

    const sent = await create(fetchMock);
    expect(sent.legendaries[0]).toMatchObject({ condition: 'ช่วยเด็กกำพร้า 3 วันติด', target: 3 });
    expect(sent.npcs[0]!.gmNote).toBe('เป็นสายลับ');
  });

  it('C3 / Q-028: a player of the game (or a game with no Human GM) has no scenario button', async () => {
    const fetchMock = loggedIn(
      view({
        humanGm: false,
        canEditScenario: false,
        you: { memberId: 'm-nok', role: 'player' },
        members: [{ id: 'm-nok', name: 'นก', role: 'player', ready: false, hasCharacter: false }],
      }),
    );
    render(<App apiBaseUrl="" />);
    expect(await screen.findByText(/ห้องทดสอบ/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /scenario/ })).toBeNull();
    expect(callsTo(fetchMock, 'GET', '/api/game/scenario')).toHaveLength(0);
  });

  it('C4: the day 12 finale has no delete button; other events do', async () => {
    await openEditor();
    const finale = events().find((g) => (within(g).getByLabelText('วัน') as HTMLInputElement).value === '12')!;
    expect(within(finale).queryByRole('button', { name: /ลบ/ })).toBeNull();
    expect(within(finale).getByText(/ฉากจบ.*ลบไม่ได้/)).toBeTruthy();

    const before = events().length;
    fireEvent.click(within(events()[0]!).getByRole('button', { name: /ลบ/ }));
    expect(events()).toHaveLength(before - 1);
  });

  it('C5: a refused scenario shows each message at its field', async () => {
    const fetchMock = await openEditor(refused({ 'timeline.5.day': 'วันต้องอยู่ระหว่าง 1 ถึง 12', 'timeline.5.title': 'ห้ามว่าง' }));
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มเหตุการณ์' }));
    await createRefused(fetchMock);

    const added = events()[5]!;
    expect(within(added).getByText('วันต้องอยู่ระหว่าง 1 ถึง 12')).toBeTruthy();
    expect(within(added).getByText('ห้ามว่าง')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/แก้ช่องที่บอกไว้/);
  });

  it('C6: in the lobby the GM reads the scenario only (no save, no reset, inputs off)', async () => {
    loggedIn(view({ status: 'started', startedAt: '2026-11-22T12:00:00.000Z', canEditScenario: false }));
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'ดู scenario' }));
    await screen.findByRole('region', { name: 'แก้ scenario' });
    expect(await screen.findByText(/แก้ไม่ได้/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'บันทึก' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ใช้ค่ามาตรฐาน' })).toBeNull();
    expect((within(events()[0]!).getByLabelText('หัวข้อ') as HTMLInputElement).disabled).toBe(true);
  });

  it('C7: [ใช้ค่ามาตรฐาน] asks first, puts the template back, and nothing is sent as scenario', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchMock = await openEditor();
    fireEvent.change(within(events()[0]!).getByLabelText('หัวข้อ'), { target: { value: 'แก้แล้ว' } });

    fireEvent.click(screen.getByRole('button', { name: 'ใช้ค่ามาตรฐาน' }));
    expect(confirm).toHaveBeenCalled();
    expect((within(events()[0]!).getByLabelText('หัวข้อ') as HTMLInputElement).value).toBe(defaultScenario().timeline[0]!.title);
    expect(await create(fetchMock)).toBeUndefined();
  });

  it('GEN-071 C5: each sheet event shows its period range and turns; the GM sets an end period and it is sent', async () => {
    const fetchMock = await openEditor();
    expect(events()).toHaveLength(5);
    expect(events().map((g) => g.querySelector('legend')!.textContent)).toEqual([
      expect.stringMatching(/วัน 1 EOSORIA.* · 2 เทิร์น$/),
      expect.stringMatching(/วัน 5 EOSORIA.* · 2 เทิร์น$/),
      expect.stringMatching(/วัน 7 HESPERION.* · 2 เทิร์น$/),
      expect.stringMatching(/วัน 10 NOCTHERION.* · 2 เทิร์น \(จุดไคลแมกซ์\)$/),
      expect.stringMatching(/วัน 12 HESPERION.* ถึง NOCTHERION.* · 4 เทิร์น \(ฉากจบ\)$/),
    ]);
    const day5 = events()[1]!;
    expect((within(day5).getByLabelText('ผลถ้าไม่มีใครแทรกแซง') as HTMLTextAreaElement).value).toBe(defaultScenario().timeline[1]!.outcome);
    expect((within(day5).getByLabelText('ปูเรื่อง (ลางบอกเหตุ)') as HTMLTextAreaElement).value).toBe(defaultScenario().timeline[1]!.foreshadowing);
    expect((within(day5).getByLabelText('ปูเรื่องวัน') as HTMLInputElement).value).toBe('4');

    const day7 = events()[2]!;
    expect((within(day7).getByLabelText('ถึงช่วง') as HTMLSelectElement).value).toBe('');
    fireEvent.change(within(day7).getByLabelText('ถึงช่วง'), { target: { value: 'NOCTHERION' } });
    expect(day7.querySelector('legend')!.textContent).toMatch(/ถึง NOCTHERION.* · 4 เทิร์น$/);
    fireEvent.change(within(day7).getByLabelText('ผลที่ผู้เล่นแทรกแซงได้'), { target: { value: 'ช่วยชาวบ้านหนีทัน' } });

    const sent = await create(fetchMock);
    expect(sent.timeline[2]).toMatchObject({ endPhase: 'NOCTHERION', interventionEffects: 'ช่วยชาวบ้านหนีทัน' });
    expect(sent.timeline[1]).toMatchObject({ endPhase: null, foreshadowAt: { day: 4, phase: 'EOSORIA' } });
  });

  it('GEN-071 C5: the server refusing an end period shows the message at that field', async () => {
    const fetchMock = await openEditor(refused({ 'timeline.2.endPhase': 'ช่วงสิ้นสุดต้องไม่อยู่ก่อนช่วงเริ่ม' }));
    fireEvent.change(within(events()[2]!).getByLabelText('ถึงช่วง'), { target: { value: 'SOLARION' } });
    await createRefused(fetchMock);
    expect(within(events()[2]!).getByText('ช่วงสิ้นสุดต้องไม่อยู่ก่อนช่วงเริ่ม')).toBeTruthy();
  });

  it('GEN-096: the GM sets start / end turns, the legend counts them and they are sent', async () => {
    const fetchMock = await openEditor();
    const day7 = events()[2]!;
    expect((within(day7).getByLabelText('เริ่มเทิร์น') as HTMLInputElement).value).toBe('1');
    expect((within(day7).getByLabelText('จบเทิร์น') as HTMLInputElement).value).toBe('2');
    fireEvent.change(within(day7).getByLabelText('เริ่มเทิร์น'), { target: { value: '2' } });
    expect(day7.querySelector('legend')!.textContent).toMatch(/วัน 7 HESPERION.* เทิร์น 2 · 1 เทิร์น$/);
    const day12 = events()[4]!;
    fireEvent.change(within(day12).getByLabelText('จบเทิร์น'), { target: { value: '1' } });
    expect(day12.querySelector('legend')!.textContent).toMatch(/ถึง NOCTHERION.* เทิร์น 1 · 3 เทิร์น \(ฉากจบ\)$/);

    const sent = await create(fetchMock);
    expect(sent.timeline[2]).toMatchObject({ startTurn: 2, endTurn: 2 });
    expect(sent.timeline[4]).toMatchObject({ startTurn: 1, endTurn: 1 });
  });

  it('GEN-096 C4: turn 3 is sent as typed and the server refusal shows at that field', async () => {
    const fetchMock = await openEditor(refused({ 'timeline.2.startTurn': 'เทิร์นต้องเป็น 1 หรือ 2' }));
    fireEvent.change(within(events()[2]!).getByLabelText('เริ่มเทิร์น'), { target: { value: '3' } });
    await createRefused(fetchMock);
    expect(within(events()[2]!).getByText('เทิร์นต้องเป็น 1 หรือ 2')).toBeTruthy();
    const body = JSON.parse(String((callsTo(fetchMock, 'POST', '/api/games')[0]![1] as RequestInit).body)) as { scenario: Scenario };
    expect(body.scenario.timeline[2]!.startTurn).toBe(3);
  });

  it('GEN-097: the GM picks several places for an event, or the whole town, and it is sent', async () => {
    const fetchMock = await openEditor();
    const placeName = (id: string) => defaultScenario().locations.find((l) => l.id === id)!.name;
    const day10 = within(events()[3]!).getByRole('group', { name: 'สถานที่' });
    expect((within(day10).getByLabelText(placeName('temple')) as HTMLInputElement).checked).toBe(true);
    expect((within(day10).getByLabelText(placeName('fountain')) as HTMLInputElement).checked).toBe(true);
    expect((within(day10).getByLabelText(placeName('market')) as HTMLInputElement).checked).toBe(false);

    const day7 = within(events()[2]!).getByRole('group', { name: 'สถานที่' });
    fireEvent.click(within(day7).getByLabelText(placeName('fountain')));
    const day5 = within(events()[1]!).getByRole('group', { name: 'สถานที่' });
    expect((within(day5).getByLabelText('ทั้งเมือง') as HTMLInputElement).checked).toBe(true);
    expect((within(day5).getByLabelText(placeName('temple')) as HTMLInputElement).disabled).toBe(true);
    const day1 = within(events()[0]!).getByRole('group', { name: 'สถานที่' });
    fireEvent.click(within(day1).getByLabelText('ทั้งเมือง'));

    const sent = await create(fetchMock);
    expect(sent.timeline.map((e) => e.locationIds)).toEqual([null, null, ['community', 'temple', 'fountain'], ['temple', 'fountain'], null]);
  });

  it('GEN-097 C5: an empty place list is sent and the server refusal shows at the places', async () => {
    const fetchMock = await openEditor(refused({ 'timeline.2.locationIds': 'ต้องมีสถานที่อย่างน้อย 1 แห่ง', 'timeline.3.locationIds.1': 'ไม่มีสถานที่ id "atlantis"' }));
    const day7 = within(events()[2]!).getByRole('group', { name: 'สถานที่' });
    for (const id of ['community', 'temple']) fireEvent.click(within(day7).getByLabelText(defaultScenario().locations.find((l) => l.id === id)!.name));
    await createRefused(fetchMock);
    expect(within(events()[2]!).getByText('ต้องมีสถานที่อย่างน้อย 1 แห่ง')).toBeTruthy();
    expect(within(events()[3]!).getByText('ไม่มีสถานที่ id "atlantis"')).toBeTruthy();
  });

  it('back to the lobby from the read-only scenario', async () => {
    loggedIn(view());
    render(<App apiBaseUrl="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'ดู scenario' }));
    await screen.findByRole('region', { name: 'แก้ scenario' });
    fireEvent.click(screen.getByRole('button', { name: 'กลับห้องรอ' }));
    expect(await screen.findByRole('region', { name: 'ห้องรอ' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'แก้ scenario' })).toBeNull();
  });
});
