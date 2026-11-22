import type { CharacterView, GameView } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { TOKEN_KEY } from '../src/session.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Routes are "METHOD /path"; the path must match the end of the URL exactly. */
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

const me = { id: 'm-lin', gameId: 'g-1', name: 'นก' };

function view(patch: Partial<GameView> = {}): GameView {
  return {
    id: 'g-1',
    name: 'เมืองก่อนอุกกาบาต',
    mode: 'single',
    humanGm: false,
    inviteCode: 'K7Q2MX',
    status: 'lobby',
    startedAt: null,
    you: { memberId: me.id, role: 'player', isOwner: true },
    members: [{ id: me.id, name: 'นก', role: 'player', isOwner: true, hasCharacter: false }],
    players: { count: 1, min: 1, max: 1 },
    canEditScenario: false,
    startBlockers: ['ยังไม่สร้างตัวละคร: นก'],
    ...patch,
  };
}

const lin = {
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา แผลเป็นที่คาง',
  personality: 'ช่างสังเกต พูดน้อย กลัวความมืด',
};

const saved: CharacterView = {
  ...lin,
  hp: { current: 100, max: 100 },
  stamina: { current: 30, max: 30 },
  coins: 0,
  socialTitle: 'คนแปลกหน้า',
  conduct: 'เป็นกลางสุดๆ',
  editable: true,
};

/** Opens the page logged in (kept token + GET /api/me + GET /api/game). */
function loggedIn(game: GameView, more: Record<string, Handler> = {}) {
  localStorage.setItem(TOKEN_KEY, 'tok-abc');
  return stubApi({
    'GET /api/me': () => Response.json({ member: me }),
    'GET /api/game': () => Response.json(game),
    ...more,
  });
}

async function openCharacter(button: RegExp = /ตัวละคร/) {
  fireEvent.click(await screen.findByRole('button', { name: button }));
}

function fill(values: Partial<typeof lin> = {}) {
  const v = { ...lin, ...values };
  fireEvent.change(screen.getByLabelText('ชื่อจริง'), { target: { value: v.name } });
  fireEvent.change(screen.getByLabelText('ลักษณะภายนอก'), { target: { value: v.appearance } });
  fireEvent.change(screen.getByLabelText('บุคลิก'), { target: { value: v.personality } });
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'บันทึกตัวละคร' }));

describe('Character creation step 1 (GEN-047)', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('C1: a complete form is saved with only name, appearance, personality and shows the starting values', async () => {
    const fetchMock = loggedIn(view(), {
      'GET /api/game/character': () => Response.json({ character: null }),
      'POST /api/game/character': () => Response.json({ character: saved }, { status: 201 }),
    });

    render(<App apiBaseUrl="" />);
    await openCharacter(/สร้างตัวละคร/);
    await screen.findByLabelText('ชื่อจริง');
    fill();
    save();

    const card = await screen.findByRole('region', { name: 'ตัวละครของคุณ' });
    expect(within(card).getByText('HP 100/100')).toBeTruthy();
    expect(within(card).getByText('Stamina 30/30')).toBeTruthy();
    expect(within(card).getByText('ฉายา: คนแปลกหน้า')).toBeTruthy();
    // GEN-067 (Q-091): your own Karma word only, never a number.
    expect(within(card).getByText('ความประพฤติ: เป็นกลางสุดๆ')).toBeTruthy();
    expect(within(card).getByText('ลิน')).toBeTruthy();
    expect(card.textContent).not.toMatch(/karma|กรรม|ชื่อเสียง|reputation/i);
    const [call] = callsTo(fetchMock, 'POST', '/api/game/character');
    expect(JSON.parse(String(call![1]?.body))).toEqual(lin);
    expect(new Headers(call![1]?.headers).get('authorization')).toBe('Bearer tok-abc');
  });

  it('C2: an empty field is flagged at that field without calling the server', async () => {
    const fetchMock = loggedIn(view(), { 'GET /api/game/character': () => Response.json({ character: null }) });

    render(<App apiBaseUrl="" />);
    await openCharacter(/สร้างตัวละคร/);
    await screen.findByLabelText('ชื่อจริง');
    fill({ personality: '' });
    save();

    expect(await screen.findByText('กรุณาใส่บุคลิก')).toBeTruthy();
    expect(screen.getByLabelText('บุคลิก').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('ชื่อจริง').getAttribute('aria-invalid')).toBe('false');
    expect(callsTo(fetchMock, 'POST', '/api/game/character')).toHaveLength(0);
  });

  it('C2: a too-long name (over 40 code points) is flagged; the field shows how many are left', async () => {
    loggedIn(view(), { 'GET /api/game/character': () => Response.json({ character: null }) });

    render(<App apiBaseUrl="" />);
    await openCharacter(/สร้างตัวละคร/);
    await screen.findByLabelText('ชื่อจริง');
    fill({ name: 'กิ'.repeat(19) });
    expect(screen.getByText('เหลือ 2 ตัวอักษร')).toBeTruthy();
    fill({ name: 'ก'.repeat(41) });
    save();

    expect(await screen.findByText('ชื่อจริงยาวได้ไม่เกิน 40 ตัวอักษร')).toBeTruthy();
  });

  it('C2: field errors from the server are shown at their field', async () => {
    loggedIn(view(), {
      'GET /api/game/character': () => Response.json({ character: null }),
      'POST /api/game/character': () =>
        Response.json(
          { code: 'invalid_input', message: 'ข้อมูลไม่ถูกต้อง', fields: { appearance: 'ลักษณะภายนอกยาวได้ไม่เกิน 500 ตัวอักษร' } },
          { status: 400 },
        ),
    });

    render(<App apiBaseUrl="" />);
    await openCharacter(/สร้างตัวละคร/);
    await screen.findByLabelText('ชื่อจริง');
    fill();
    save();

    expect(await screen.findByText('ลักษณะภายนอกยาวได้ไม่เกิน 500 ตัวอักษร')).toBeTruthy();
    expect(screen.getByLabelText('ลักษณะภายนอก').getAttribute('aria-invalid')).toBe('true');
  });

  it('C3: with a character already, the lobby offers to view it and no second create form opens', async () => {
    const fetchMock = loggedIn(
      view({ members: [{ ...view().members[0]!, hasCharacter: true }], startBlockers: [] }),
      { 'GET /api/game/character': () => Response.json({ character: saved }) },
    );

    render(<App apiBaseUrl="" />);
    expect(screen.queryByRole('button', { name: /สร้างตัวละคร/ })).toBeNull();
    await openCharacter(/ดูตัวละคร/);

    expect(await screen.findByText('ฉายา: คนแปลกหน้า')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'บันทึกตัวละคร' })).toBeNull();
    expect(callsTo(fetchMock, 'POST', '/api/game/character')).toHaveLength(0);
  });

  it('C5: before the start the identity is edited with PUT', async () => {
    const fetchMock = loggedIn(view({ members: [{ ...view().members[0]!, hasCharacter: true }] }), {
      'GET /api/game/character': () => Response.json({ character: saved }),
      'PUT /api/game/character': () => Response.json({ character: { ...saved, name: 'ลินดา' } }),
    });

    render(<App apiBaseUrl="" />);
    await openCharacter(/ดูตัวละคร/);
    fireEvent.click(await screen.findByRole('button', { name: 'แก้ไข' }));
    expect((screen.getByLabelText('ชื่อจริง') as HTMLInputElement).value).toBe('ลิน');
    fill({ name: 'ลินดา' });
    save();

    expect(await screen.findByText('ลินดา')).toBeTruthy();
    expect(JSON.parse(String(callsTo(fetchMock, 'PUT', '/api/game/character')[0]![1]?.body))).toEqual({ ...lin, name: 'ลินดา' });
  });

  it('C5: once the game started there is no edit button', async () => {
    loggedIn(
      view({ status: 'started', startedAt: '2026-11-22T12:00:00.000Z', members: [{ ...view().members[0]!, hasCharacter: true }] }),
      { 'GET /api/game/character': () => Response.json({ character: { ...saved, editable: false } }) },
    );

    render(<App apiBaseUrl="" />);
    await openCharacter(/ดูตัวละคร/);

    expect(await screen.findByText('ฉายา: คนแปลกหน้า')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'แก้ไข' })).toBeNull();
    expect(screen.getByText(/เกมเริ่มแล้ว แก้ตัวตนไม่ได้/)).toBeTruthy();
  });

  it('C6: after a reload the saved character is loaded from the server', async () => {
    const fetchMock = loggedIn(view({ members: [{ ...view().members[0]!, hasCharacter: true }] }), {
      'GET /api/game/character': () => Response.json({ character: saved }),
    });

    render(<App apiBaseUrl="" />);
    await openCharacter(/ดูตัวละคร/);

    const card = await screen.findByRole('region', { name: 'ตัวละครของคุณ' });
    expect(within(card).getByText(lin.appearance)).toBeTruthy();
    expect(within(card).getByText(lin.personality)).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', '/api/game/character')).toHaveLength(1);
  });

  it('back to the lobby reloads it, so the player now counts as having a character', async () => {
    let game = view();
    loggedIn(view(), {
      'GET /api/game': () => Response.json(game),
      'GET /api/game/character': () => Response.json({ character: null }),
      'POST /api/game/character': () => {
        game = view({ members: [{ ...view().members[0]!, hasCharacter: true }], startBlockers: [] });
        return Response.json({ character: saved }, { status: 201 });
      },
    });

    render(<App apiBaseUrl="" />);
    await openCharacter(/สร้างตัวละคร/);
    await screen.findByLabelText('ชื่อจริง');
    fill();
    save();
    await screen.findByText('ฉายา: คนแปลกหน้า');
    fireEvent.click(screen.getByRole('button', { name: 'กลับห้องรอ' }));

    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'สมาชิก' })).getByText(/สร้างตัวละครแล้ว/)).toBeTruthy(),
    );
  });

  it('the Human GM has no character button', async () => {
    loggedIn(
      view({
        mode: 'online',
        humanGm: true,
        you: { memberId: me.id, role: 'gm', isOwner: true },
        members: [{ id: me.id, name: 'นก', role: 'gm', isOwner: true, hasCharacter: false }],
      }),
    );

    render(<App apiBaseUrl="" />);

    expect(await screen.findByText('K7Q-2MX')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ตัวละคร/ })).toBeNull();
  });
});
