import type { AiUsageGameResponse, AiUsageOverviewResponse, UsageCeiling, UsageTotals } from '@isekai/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_TOKEN_KEY, AdminDashboard, USAGE_POLL_MS } from '../src/AdminDashboard.tsx';

// GEN-061: the server owner's AI usage dashboard at <web>/admin.

const totals = (t: Partial<UsageTotals> = {}): UsageTotals => ({
  calls: 0,
  okCalls: 0,
  failedCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsdMicros: 0,
  unpricedCalls: 0,
  ...t,
});
const ceiling = (c: Partial<UsageCeiling> = {}): UsageCeiling => ({
  spentUsdMicros: 0,
  ceilingUsdMicros: 20_000_000,
  percent: 0,
  status: 'ok',
  ...c,
});

const GAME = { id: 'g-1', name: 'เมืองก่อนอุกกาบาต' };
const C1_TOTALS = totals({ calls: 3, okCalls: 3, inputTokens: 2800, cachedInputTokens: 1300, outputTokens: 650, costUsdMicros: 9665 });

function detail(d: Partial<AiUsageGameResponse> = {}): AiUsageGameResponse {
  return {
    generatedAt: '2026-11-22T12:00:00.000Z',
    game: GAME,
    ceiling: ceiling(),
    totals: C1_TOTALS,
    byPurpose: [
      { purpose: 'gm_adjudicate', totals: totals({ calls: 2, okCalls: 2, inputTokens: 2200, cachedInputTokens: 1300, outputTokens: 500, costUsdMicros: 9530 }) },
      { purpose: 'summarize_day', totals: totals({ calls: 1, okCalls: 1, inputTokens: 600, outputTokens: 150, costUsdMicros: 135 }) },
    ],
    byPeriod: [
      { day: 1, phase: 'EOSORIA', totals: totals({ calls: 2, inputTokens: 2200 }) },
      { day: 3, phase: 'SOLARION', totals: totals({ calls: 1, inputTokens: 777 }) },
    ],
    byModel: [{ model: 'claude-sonnet-5-5', priced: true, totals: C1_TOTALS }],
    failures: [],
    refusals: [],
    ...d,
  };
}

function overview(o: Partial<AiUsageOverviewResponse> = {}): AiUsageOverviewResponse {
  return {
    generatedAt: '2026-11-22T12:00:00.000Z',
    totals: C1_TOTALS,
    byPurpose: [],
    failures: [],
    games: [{ game: GAME, totals: C1_TOTALS, ceiling: ceiling(), lastCallAt: '2026-11-22T12:00:00.000Z' }],
    ...o,
  };
}

/** A fake server: the admin code `รหัสเจ้าของ` gives token `adm-1`; data routes need that token. */
function fakeServer(state: { overview: AiUsageOverviewResponse; detail: AiUsageGameResponse; forbidden?: boolean }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url.endsWith('/api/admin/session')) {
      const body = JSON.parse(String(init?.body)) as { code: string };
      return body.code === 'รหัสเจ้าของ'
        ? Response.json({ token: 'adm-1', expiresAt: '2026-11-22T13:00:00.000Z' })
        : Response.json({ code: 'wrong_admin_code', message: 'admin code ไม่ถูกต้อง' }, { status: 403 });
    }
    if (url.endsWith('/api/admin/logout')) return new Response(null, { status: 204 });
    if (state.forbidden || auth !== 'Bearer adm-1') return Response.json({ code: 'forbidden', message: 'หน้านี้สำหรับเจ้าของ server เท่านั้น' }, { status: 403 });
    if (url.endsWith('/api/admin/ai-usage')) return Response.json(state.overview);
    if (url.endsWith(`/api/admin/ai-usage/${GAME.id}`)) return Response.json(state.detail);
    return Response.json({ code: 'game_not_found', message: 'ไม่พบเกมนี้' }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function login() {
  render(<AdminDashboard apiBaseUrl="" />);
  fireEvent.change(await screen.findByLabelText('admin code'), { target: { value: 'รหัสเจ้าของ' } });
  fireEvent.click(screen.getByRole('button', { name: 'เข้า dashboard' }));
  await screen.findByRole('heading', { name: 'การใช้ AI ทุกเกม' });
  // The numbers load after the heading.
  await screen.findByRole('table', { name: 'รายเกม' });
}

async function openGame() {
  fireEvent.click(screen.getByRole('button', { name: GAME.name }));
  return screen.findByRole('region', { name: `เกม ${GAME.name}` });
}

describe('AI usage dashboard (GEN-061)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('a wrong admin code shows the server message and no data', async () => {
    fakeServer({ overview: overview(), detail: detail() });
    render(<AdminDashboard apiBaseUrl="" />);
    fireEvent.change(screen.getByLabelText('admin code'), { target: { value: 'เดา' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้า dashboard' }));
    expect(await screen.findByText('admin code ไม่ถูกต้อง')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'การใช้ AI ทุกเกม' })).toBeNull();
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
  });

  it('C1: totals of input / cached / output, the cost estimate and each purpose, for all games and one game', async () => {
    fakeServer({ overview: overview(), detail: detail() });
    await login();
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe('adm-1');

    const all = screen.getByRole('region', { name: 'ยอดรวมทุกเกม' });
    expect(within(all).getByText('2,800')).toBeTruthy();
    expect(within(all).getByText('$0.0097')).toBeTruthy();

    const game = await openGame();
    const sum = within(game).getByRole('table', { name: 'ยอดรวม' });
    expect(within(sum).getByRole('row', { name: /input 2,800/ })).toBeTruthy();
    expect(within(sum).getByRole('row', { name: /cached 1,300/ })).toBeTruthy();
    expect(within(sum).getByRole('row', { name: /output 650/ })).toBeTruthy();
    expect(within(sum).getByRole('row', { name: /ค่าใช้จ่ายประมาณ \$0\.0097/ })).toBeTruthy();
    const purposes = within(game).getByRole('table', { name: 'แยกตาม purpose' });
    expect(within(purposes).getByRole('row', { name: /ตัดสินผล \(resolve phase\) 2 2,200 1,300 500/ })).toBeTruthy();
    expect(within(purposes).getByRole('row', { name: /สรุปความจำรายวัน 1 600 0 150/ })).toBeTruthy();
  });

  it('C2: the day 3 SOLARION call is in the day 3 SOLARION cell, not another', async () => {
    fakeServer({ overview: overview(), detail: detail() });
    await login();
    const game = await openGame();
    const grid = within(game).getByRole('table', { name: 'แยกตามวันและช่วงเวลา' });
    expect(within(grid).getByTestId('period-3-SOLARION').textContent).toContain('777');
    expect(within(grid).getByTestId('period-3-EOSORIA').textContent).not.toContain('777');
    expect(within(grid).getByTestId('period-1-EOSORIA').textContent).toContain('2,200');
  });

  it('C3: a warning bar at 80 % of the game ceiling', async () => {
    const warn = ceiling({ spentUsdMicros: 16_000_000, percent: 80, status: 'warning' });
    fakeServer({
      overview: overview({ games: [{ game: GAME, totals: C1_TOTALS, ceiling: warn, lastCallAt: null }] }),
      detail: detail({ ceiling: warn }),
    });
    await login();
    const game = await openGame();
    expect(within(game).getByRole('alert').textContent).toMatch(/ใช้ไปแล้ว 80% ของเพดาน/);
    expect((within(game).getByRole('progressbar') as HTMLProgressElement).value).toBe(80);
  });

  it('C3: at 100 % it says the AI GM stopped because of the ceiling', async () => {
    const full = ceiling({ spentUsdMicros: 20_000_000, percent: 100, status: 'reached' });
    fakeServer({
      overview: overview({ games: [{ game: GAME, totals: C1_TOTALS, ceiling: full, lastCallAt: null }] }),
      detail: detail({ ceiling: full }),
    });
    await login();
    expect(screen.getByRole('row', { name: new RegExp(GAME.name) }).textContent).toMatch(/ถึงเพดาน/);
    const game = await openGame();
    expect(within(game).getByRole('alert').textContent).toMatch(/AI GM หยุดเพราะถึงเพดาน/);
  });

  it('C4: failed calls counted apart from successful ones, with their kind', async () => {
    fakeServer({
      overview: overview(),
      detail: detail({
        totals: totals({ calls: 6, okCalls: 1, failedCalls: 5 }),
        failures: [
          { kind: 'timeout', count: 2 },
          { kind: 'invalid_json', count: 1 },
          { kind: 'refusal', count: 1 },
          { kind: 'schema_mismatch', count: 1 },
        ],
      }),
    });
    await login();
    const game = await openGame();
    const sum = within(game).getByRole('table', { name: 'ยอดรวม' });
    expect(within(sum).getByRole('row', { name: /สำเร็จ 1/ })).toBeTruthy();
    expect(within(sum).getByRole('row', { name: /ล้มเหลว 5/ })).toBeTruthy();
    const failures = within(game).getByRole('table', { name: 'call ที่ล้มเหลว' });
    expect(within(failures).getByRole('row', { name: /หมดเวลา \(timeout\) 2/ })).toBeTruthy();
    expect(within(failures).getByRole('row', { name: /AI ปฏิเสธ \(refusal\) 1/ })).toBeTruthy();
    expect(within(failures).getByRole('row', { name: /JSON ผิด \(invalid_json\) 1/ })).toBeTruthy();
  });

  it('GEN-199 C1 / C3: the admin sees each refused answer: the path, what the AI gave, the expected value and the scrubbed answer', async () => {
    const proposal = '{"actions":[{"actionId":"act-1","staminaCost":99,"reason":"{{p:r1}} ค้นห้อง"}]}';
    fakeServer({
      overview: overview(),
      detail: detail({
        refusals: [
          {
            at: '2026-11-22T11:58:00.000Z',
            purpose: 'gm_adjudicate',
            stage: 'first',
            errors: [{ code: 'stamina_cost_mismatch', path: 'actions[0].staminaCost', message: 'general costs 3, got 99', got: '99' }],
            proposal,
          },
        ],
      }),
    });
    await login();
    const game = await openGame();
    const table = within(game).getByRole('table', { name: 'คำตอบ AI ที่ถูกตีกลับ' });
    expect(within(table).getByRole('row', { name: /ตัดสินผล \(resolve phase\).*stamina_cost_mismatch.*actions\[0\]\.staminaCost.*99.*general costs 3, got 99/ })).toBeTruthy();
    expect(within(game).getByText(proposal)).toBeTruthy();
  });

  it('C5: a 403 (expired or not the server owner) goes back to the admin code form', async () => {
    const state = { overview: overview(), detail: detail(), forbidden: false };
    fakeServer(state);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await login();
    state.forbidden = true;
    await act(() => vi.advanceTimersByTimeAsync(USAGE_POLL_MS));
    expect(screen.getByLabelText('admin code')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('หน้านี้สำหรับเจ้าของ server เท่านั้น');
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull();
  });

  it('C6: a game with no call shows an empty state instead of empty tables', async () => {
    const empty = detail({ totals: totals(), byPurpose: [], byPeriod: [], byModel: [], failures: [] });
    fakeServer({ overview: overview({ totals: totals(), games: [{ game: GAME, totals: totals(), ceiling: ceiling(), lastCallAt: null }] }), detail: empty });
    await login();
    expect(screen.getByText('ยังไม่มีการเรียก AI')).toBeTruthy();
    const game = await openGame();
    expect(within(game).getByText('เกมนี้ยังไม่มีการเรียก AI')).toBeTruthy();
    expect(within(game).queryByRole('table')).toBeNull();
  });

  it('C7: numbers update by themselves within 30 seconds, without a reload', async () => {
    const state = { overview: overview(), detail: detail() };
    const fetchMock = fakeServer(state);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await login();
    await openGame();
    expect(USAGE_POLL_MS).toBeLessThanOrEqual(30_000);

    state.detail = detail({ totals: { ...C1_TOTALS, calls: 4, okCalls: 4, inputTokens: 3900 } });
    const before = fetchMock.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(USAGE_POLL_MS));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    const game = screen.getByRole('region', { name: `เกม ${GAME.name}` });
    expect(within(within(game).getByRole('table', { name: 'ยอดรวม' })).getByRole('row', { name: /input 3,900/ })).toBeTruthy();
  });

  it('C8: a model without a price shows its tokens and "ไม่ทราบราคา", not $0', async () => {
    const unpriced = totals({ calls: 1, okCalls: 1, inputTokens: 4000, outputTokens: 400, unpricedCalls: 1 });
    fakeServer({
      overview: overview(),
      detail: detail({ totals: unpriced, byModel: [{ model: 'mystery-model-9', priced: false, totals: unpriced }] }),
    });
    await login();
    const game = await openGame();
    const sum = within(game).getByRole('table', { name: 'ยอดรวม' });
    expect(within(sum).getByRole('row', { name: /ค่าใช้จ่ายประมาณ ไม่ทราบราคา/ })).toBeTruthy();
    expect(within(sum).queryByText('$0.0000')).toBeNull();
    const models = within(game).getByRole('table', { name: 'แยกตาม model' });
    expect(within(models).getByRole('row', { name: /mystery-model-9 1 4,000 0 400 ไม่ทราบราคา/ })).toBeTruthy();
  });
});
