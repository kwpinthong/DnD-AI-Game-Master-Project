import type { CharacterView, GameView, LootOption, LootView } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const game: GameView = {
  id: 'g-1',
  name: 'เมืองก่อนอุกกาบาต',
  mode: 'single',
  humanGm: false,
  inviteCode: 'K7Q2MX',
  status: 'lobby',
  startedAt: null,
  you: { memberId: me.id, role: 'player', isOwner: true },
  members: [{ id: me.id, name: 'นก', role: 'player', isOwner: true, hasCharacter: true }],
  players: { count: 1, min: 1, max: 1 },
  canEditScenario: false,
  startBlockers: [],
};

const saved: CharacterView = {
  name: 'ลิน',
  appearance: 'หญิงผ้าคลุมเทา',
  personality: 'ช่างสังเกต กลัวความมืด',
  hp: { current: 100, max: 100 },
  stamina: { current: 30, max: 30 },
  socialTitle: 'คนแปลกหน้า',
  editable: true,
};

const option = (id: string, kind: 'skill' | 'item', name: string, quantitative = false): LootOption => ({
  id,
  kind,
  name,
  description: `${name} คำอธิบาย`,
  tier: 'Common',
  buffType: quantitative ? 'Quantitative' : 'Qualitative',
  effect: quantitative ? { type: 'damage_reduction', value: 2 } : null,
});

function offerView(prefix = '', patch: Partial<LootView> = {}): LootView {
  return {
    offer: {
      strength: { label: `${prefix}ช่างสังเกต`, description: 'มองเห็นรายละเอียด' },
      weakness: { label: `${prefix}กลัวความมืด`, description: 'ใจสั่นในที่มืด' },
      skills: [option(`${prefix}s1`, 'skill', `${prefix}อ่านสีหน้า`), option(`${prefix}s2`, 'skill', `${prefix}สายตาเหยี่ยว`, true)],
      items: [option(`${prefix}i1`, 'item', `${prefix}เสื้อหนัง`, true), option(`${prefix}i2`, 'item', `${prefix}สมุดจด`)],
    },
    chosen: null,
    rerollsUsed: 0,
    rerollLimit: null,
    canReroll: true,
    ...patch,
  };
}

/** The kept set: skill and item number `index` of the default offer. */
function chosenOf(index: number): LootView['chosen'] {
  const { strength, weakness, skills, items } = offerView().offer!;
  return { strength, weakness, skill: skills[index]!, item: items[index]! };
}

const empty: LootView = { offer: null, chosen: null, rerollsUsed: 0, rerollLimit: null, canReroll: true };
const loot = (view: LootView, status = 200) => Response.json({ loot: view }, { status });

function loggedIn(routes: Record<string, Handler>) {
  localStorage.setItem(TOKEN_KEY, 'tok-abc');
  return stubApi({
    'GET /api/me': () => Response.json({ member: me }),
    'GET /api/game': () => Response.json(game),
    'GET /api/game/character': () => Response.json({ character: saved }),
    ...routes,
  });
}

async function openLoot() {
  render(<App apiBaseUrl="" />);
  fireEvent.click(await screen.findByRole('button', { name: /ตัวละคร/ }));
  return screen.findByRole('region', { name: 'ของติดตัว' });
}

describe('Character loot step (GEN-048)', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('C1: the AI offer is shown; picking one skill + one item saves them and shows Common + buffType', async () => {
    const chosen: LootView = { ...empty, canReroll: false, chosen: chosenOf(1) };
    const fetchMock = loggedIn({
      'GET /api/game/character/loot': () => loot(empty),
      'POST /api/game/character/loot': () => loot(offerView()),
      'POST /api/game/character/loot/choose': () => loot(chosen),
    });

    const section = await openLoot();
    fireEvent.click(await within(section).findByRole('button', { name: 'ให้ AI วิเคราะห์บุคลิก' }));

    expect(await within(section).findByText(/จุดแข็ง: ช่างสังเกต/)).toBeTruthy();
    expect(within(section).getByText(/จุดอ่อน: กลัวความมืด/)).toBeTruthy();
    const skills = within(section).getByRole('radiogroup', { name: 'เลือก skill 1 อย่าง' });
    expect(within(skills).getAllByRole('radio')).toHaveLength(2);
    expect(within(skills).getByLabelText(/สายตาเหยี่ยว.*Common.*เชิงปริมาณ/)).toBeTruthy();
    expect(within(skills).getByLabelText(/อ่านสีหน้า.*Common.*เชิงคุณภาพ/)).toBeTruthy();

    fireEvent.click(within(skills).getByLabelText(/สายตาเหยี่ยว/));
    fireEvent.click(within(section).getByLabelText(/สมุดจด/));
    fireEvent.click(within(section).getByRole('button', { name: 'ยืนยันของติดตัว' }));

    const kept = await within(section).findByRole('list', { name: 'ของติดตัวที่เลือก' });
    expect(kept.textContent).toMatch(/สายตาเหยี่ยว.*Common.*เชิงปริมาณ/);
    expect(kept.textContent).toMatch(/สมุดจด.*Common.*เชิงคุณภาพ/);
    const [call] = callsTo(fetchMock, 'POST', '/api/game/character/loot/choose');
    expect(JSON.parse(String(call![1]?.body))).toEqual({ skillIds: ['s2'], itemIds: ['i2'] });
  });

  it('C1: after a reload the kept skill and item are loaded from the server', async () => {
    loggedIn({
      'GET /api/game/character/loot': () =>
        loot({ ...empty, canReroll: false, chosen: chosenOf(0) }),
    });

    const section = await openLoot();

    const kept = await within(section).findByRole('list', { name: 'ของติดตัวที่เลือก' });
    expect(kept.textContent).toContain('อ่านสีหน้า');
    expect(kept.textContent).toContain('เสื้อหนัง');
    expect(within(section).queryByRole('button', { name: 'สุ่มใหม่' })).toBeNull();
  });

  it('C4: confirming without an item is refused on the page and nothing is sent', async () => {
    const fetchMock = loggedIn({ 'GET /api/game/character/loot': () => loot(offerView()) });

    const section = await openLoot();
    fireEvent.click(await within(section).findByLabelText(/อ่านสีหน้า/));
    fireEvent.click(within(section).getByRole('button', { name: 'ยืนยันของติดตัว' }));

    expect((await within(section).findByRole('alert')).textContent).toContain('กรุณาเลือกไอเท็ม 1 อย่าง');
    expect(callsTo(fetchMock, 'POST', '/api/game/character/loot/choose')).toHaveLength(0);
  });

  it('C4: a refusal from the server is shown', async () => {
    loggedIn({
      'GET /api/game/character/loot': () => loot(offerView()),
      'POST /api/game/character/loot/choose': () =>
        Response.json(
          { code: 'invalid_input', message: 'เลือกของติดตัวไม่ถูกต้อง', fields: { skillIds: 'skill ที่เลือกไม่อยู่ในตัวเลือก' } },
          { status: 400 },
        ),
    });

    const section = await openLoot();
    fireEvent.click(await within(section).findByLabelText(/อ่านสีหน้า/));
    fireEvent.click(within(section).getByLabelText(/เสื้อหนัง/));
    fireEvent.click(within(section).getByRole('button', { name: 'ยืนยันของติดตัว' }));

    expect((await within(section).findByRole('alert')).textContent).toContain('skill ที่เลือกไม่อยู่ในตัวเลือก');
  });

  it('C5: an AI error shows the message and a retry button; the old set stays and the retry works', async () => {
    let rolls = 0;
    loggedIn({
      'GET /api/game/character/loot': () => loot(offerView()),
      'POST /api/game/character/loot': () => {
        rolls++;
        return rolls === 1
          ? Response.json({ code: 'ai_unavailable', message: 'AI วิเคราะห์บุคลิกไม่สำเร็จ ลองใหม่อีกครั้ง' }, { status: 503 })
          : loot(offerView('ใหม่-', { rerollsUsed: 1 }));
      },
    });

    const section = await openLoot();
    fireEvent.click(await within(section).findByRole('button', { name: 'สุ่มใหม่' }));

    expect((await within(section).findByRole('alert')).textContent).toContain('AI วิเคราะห์บุคลิกไม่สำเร็จ');
    expect(within(section).getByText(/จุดแข็ง: ช่างสังเกต/)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'ลองใหม่' }));

    expect(await within(section).findByText(/จุดแข็ง: ใหม่-ช่างสังเกต/)).toBeTruthy();
    expect(within(section).queryByRole('alert')).toBeNull();
    expect(rolls).toBe(2);
  });

  it('C7: a reroll replaces the shown set and clears the picks', async () => {
    loggedIn({
      'GET /api/game/character/loot': () => loot(offerView()),
      'POST /api/game/character/loot': () => loot(offerView('ชุดสอง-', { rerollsUsed: 1 })),
    });

    const section = await openLoot();
    fireEvent.click(await within(section).findByLabelText(/อ่านสีหน้า/));
    fireEvent.click(within(section).getByRole('button', { name: 'สุ่มใหม่' }));

    expect(await within(section).findByLabelText(/ชุดสอง-อ่านสีหน้า/)).toBeTruthy();
    expect(within(section).queryByLabelText(/^อ่านสีหน้า/)).toBeNull();
    expect(within(section).getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(within(section).getByText(/สุ่มใหม่ได้ไม่จำกัด/)).toBeTruthy();
  });

  it('C7: the reroll button is disabled while a request is in flight and when the quota is used up', async () => {
    let release = () => {};
    loggedIn({
      'GET /api/game/character/loot': () => loot(offerView()),
      'POST /api/game/character/loot': () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(loot(offerView('', { rerollsUsed: 3, rerollLimit: 3, canReroll: false })));
        }),
    });

    const section = await openLoot();
    const reroll = (await within(section).findByRole('button', { name: 'สุ่มใหม่' })) as HTMLButtonElement;
    fireEvent.click(reroll);
    expect(reroll.disabled).toBe(true);

    release();
    expect(await within(section).findByText(/สุ่มใหม่ครบ 3 ครั้งแล้ว/)).toBeTruthy();
    expect((within(section).getByRole('button', { name: 'สุ่มใหม่' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
