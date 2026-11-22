// GEN-090: Join + create game + lobby + character creation v2, on the GEN-100 mock (the GEN-099 fixtures).
// C1 steps + going back, C2 errors at the field and the next button off, C3 loot loading / AI failure,
// C4 a started game goes to Play, C5 nothing wider than a 390 px screen, C6 a new member shows by itself.
import { ApiError } from '@isekai/protocol';
import { CONTRACT, CONTRACT_SCHEMAS, type HttpItem } from '@isekai/protocol/contract';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterScreen } from '../src/CharacterScreen.tsx';
import { CreateGameForm } from '../src/CreateGameForm.tsx';
import { JoinForm } from '../src/JoinForm.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { routeKey } from '../src/mock/http.ts';
import { installMock, MOCK_TOKEN, mockBaseUrl } from '../src/mock/install.ts';
import { SCENARIOS } from '../src/mock/scenarios.ts';
import { OriginCard } from '../src/OriginCard.tsx';

const noop = () => {};
let uninstall: () => void;
let cell = 0;
const base = (scenario: string) => mockBaseUrl(scenario, `p${++cell}`);

function mock(timeScale = 0.01) {
  uninstall?.();
  uninstall = installMock({ timeScale, latencyMs: 0 });
}

beforeEach(() => {
  localStorage.clear();
  mock();
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.restoreAllMocks();
});

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const type = (label: string | RegExp, value: string) => {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  return input;
};
/** The field block an input sits in: its error must be inside it, not somewhere else on the page. */
const fieldOf = (label: string | RegExp) => screen.getByLabelText(label).closest('.field') as HTMLElement;
const currentStep = () => document.querySelector('[aria-current="step"]')?.textContent ?? '';

function character(scenario: string, more: Partial<Parameters<typeof CharacterScreen>[0]> = {}) {
  const props = { apiBaseUrl: base(scenario), token: MOCK_TOKEN, onBack: noop, onSessionLost: noop, onGameStarted: noop, ...more };
  render(<CharacterScreen {...props} />);
}

function fillIdentity() {
  type('ชื่อจริง', 'ลิน');
  type('ลักษณะภายนอก', 'หญิงผ้าคลุมเทา แผลเป็นที่คาง');
  type('บุคลิก', 'ช่างสังเกต พูดน้อย จำหน้าคนแม่น');
}

describe('C1 the character steps show where you are and let you go back', () => {
  it('identity → loot → review: "ขั้นที่ n / 3" follows, and an earlier step opens again with what was typed', async () => {
    const onBack = vi.fn();
    character('no-character', { onBack });
    await screen.findByLabelText('ชื่อจริง');
    expect(screen.getByText('ขั้นที่ 1 / 3')).toBeTruthy();
    expect(currentStep()).toContain('ตัวตน');

    fillIdentity();
    fireEvent.click(button('ถัดไป: ของติดตัว'));
    expect(await screen.findByText('ขั้นที่ 2 / 3')).toBeTruthy();
    expect(currentStep()).toContain('ของติดตัว');

    // back to step 1: the saved identity is in the fields again
    fireEvent.click(button('ย้อนกลับ'));
    expect(screen.getByText('ขั้นที่ 1 / 3')).toBeTruthy();
    expect((screen.getByLabelText('ชื่อจริง') as HTMLInputElement).value).toBe('ลิน');
    fireEvent.click(button('ถัดไป: ของติดตัว'));

    const loot = await screen.findByRole('region', { name: 'ของติดตัว' });
    // nothing kept yet: the review step is closed, with the reason in words
    expect(button('ถัดไป: ตรวจทาน').disabled).toBe(true);
    expect(screen.getByText('เลือกความสามารถและของติดตัวให้ครบก่อน')).toBeTruthy();
    fireEvent.click(await within(loot).findByLabelText(/Glare of Truth/));
    fireEvent.click(within(loot).getByLabelText(/Prism of Truth/));
    fireEvent.click(within(loot).getByRole('button', { name: 'ยืนยันของติดตัว' }));
    await within(loot).findByRole('list', { name: 'ของติดตัวที่เลือก' });

    fireEvent.click(button('ถัดไป: ตรวจทาน'));
    expect(await screen.findByText('ขั้นที่ 3 / 3')).toBeTruthy();
    const review = screen.getByRole('region', { name: 'ตัวละครของคุณ' });
    expect(review.textContent).toContain('ลิน');
    expect(review.textContent).toContain('Glare of Truth');
    expect(review.textContent).toContain('Prism of Truth');
    expect(within(review).getByText(/จุดเกิดของคุณจะสุ่มตอนเกมเริ่ม/)).toBeTruthy();

    // from the review, the step bar goes straight back to step 1
    fireEvent.click(within(screen.getByRole('navigation', { name: 'ขั้นตอนสร้างตัวละคร' })).getByRole('button', { name: /ตัวตน/ }));
    expect(screen.getByText('ขั้นที่ 1 / 3')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('the review confirms and goes back to the lobby', async () => {
    const onBack = vi.fn();
    character('start-while-creating', { onBack });
    await screen.findByRole('list', { name: 'ของติดตัวที่เลือก' });
    fireEvent.click(button('ถัดไป: ตรวจทาน'));
    fireEvent.click(await screen.findByRole('button', { name: 'ยืนยันตัวละคร' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('C2 a wrong value is told in Thai at its field and the next button stays off', () => {
  it('Join: an empty name and a short PIN', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<JoinForm apiBaseUrl={base('guest')} onJoined={noop} />);
    expect(button('เข้าร่วม').disabled).toBe(true);

    type('โค้ดเกม', 'K7Q-2MX');
    fireEvent.blur(screen.getByLabelText('ชื่อผู้เล่น'));
    type('PIN', '12');

    expect(within(fieldOf('ชื่อผู้เล่น')).getByRole('alert').textContent).toBe('กรุณาใส่ชื่อผู้เล่น');
    expect(within(fieldOf('PIN')).getByRole('alert').textContent).toBe('PIN ต้องเป็นตัวเลข 4-6 หลัก');
    expect(within(fieldOf('โค้ดเกม')).queryByRole('alert')).toBeNull();
    expect(button('เข้าร่วม').disabled).toBe(true);
    fireEvent.click(button('เข้าร่วม'));
    expect(fetchSpy).not.toHaveBeenCalled();

    type('ชื่อผู้เล่น', 'นก');
    type('PIN', '1234');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('เข้าร่วม').disabled).toBe(false);
  });

  it('Join: a field is not flagged before the player has left it', () => {
    render(<JoinForm apiBaseUrl={base('guest')} onJoined={noop} />);
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '1' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Create game: an empty game name and a short PIN', () => {
    render(<CreateGameForm apiBaseUrl={base('guest')} onCreated={noop} onBack={noop} />);
    type('Create code', 'ลับเฉพาะ');
    fireEvent.blur(screen.getByLabelText('ชื่อเกม'));
    type('ชื่อผู้เล่นของคุณ', 'นก');
    type('PIN ของคุณ', '123');

    expect(within(fieldOf('ชื่อเกม')).getByRole('alert').textContent).toBe('กรุณาใส่ชื่อเกม');
    expect(within(fieldOf('PIN ของคุณ')).getByRole('alert').textContent).toBe('PIN ต้องเป็นตัวเลข 4-6 หลัก');
    expect(button('สร้างเกมและรับโค้ด').disabled).toBe(true);

    type('ชื่อเกม', 'เมืองก่อนอุกกาบาต');
    type('PIN ของคุณ', '1234');
    expect(button('สร้างเกมและรับโค้ด').disabled).toBe(false);
  });

  it('Character: an empty real name', async () => {
    character('no-character');
    await screen.findByLabelText('ชื่อจริง');
    expect(button('ถัดไป: ของติดตัว').disabled).toBe(true);
    fillIdentity();
    expect(button('ถัดไป: ของติดตัว').disabled).toBe(false);
    type('ชื่อจริง', '   ');

    expect(within(fieldOf('ชื่อจริง')).getByRole('alert').textContent).toBe('กรุณาใส่ชื่อจริงของตัวละคร');
    expect(within(fieldOf('บุคลิก')).queryByRole('alert')).toBeNull();
    expect(button('ถัดไป: ของติดตัว').disabled).toBe(true);
    expect(screen.getByText('ขั้นที่ 1 / 3')).toBeTruthy();
  });
});

describe('C3 waiting for the loot, and the AI failing', () => {
  const lootPosts = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([input, init]) => String(input).endsWith('/api/game/character/loot') && (init as RequestInit | undefined)?.method === 'POST');

  it('loot-loading: a loading state shows and a second press sends nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    character('loot-loading');
    const loot = await screen.findByRole('region', { name: 'ของติดตัว' });
    fireEvent.click(await within(loot).findByRole('button', { name: 'ให้ AI วิเคราะห์บุคลิก' }));

    expect(await within(loot).findByText('AI กำลังอ่านบุคลิกของคุณ…')).toBeTruthy();
    const busy = loot.querySelector('button[aria-busy="true"]') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(lootPosts(fetchSpy)).toHaveLength(1);
    expect(button('ถัดไป: ตรวจทาน').disabled).toBe(true);
  });

  it('loot-error: the AI failure is told with a retry button that asks again', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    character('loot-error');
    const loot = await screen.findByRole('region', { name: 'ของติดตัว' });
    fireEvent.click(await within(loot).findByRole('button', { name: 'ให้ AI วิเคราะห์บุคลิก' }));

    expect((await within(loot).findByRole('alert')).textContent).toContain('วิเคราะห์ไม่สำเร็จ ลองอีกครั้ง');
    expect(within(loot).queryByText('AI กำลังอ่านบุคลิกของคุณ…')).toBeNull();
    fireEvent.click(within(loot).getByRole('button', { name: 'ลองใหม่' }));
    await waitFor(() => expect(lootPosts(fetchSpy)).toHaveLength(2));
    expect((await within(loot).findByRole('alert')).textContent).toContain('วิเคราะห์ไม่สำเร็จ ลองอีกครั้ง');
  });
});

describe('C4 once the game has started the character page goes to Play', () => {
  it('normal (started): no form, nothing to edit, and the page asks to open Play', async () => {
    const onGameStarted = vi.fn();
    character('normal', { onGameStarted });

    await waitFor(() => expect(onGameStarted).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toContain('เกมเริ่มแล้ว แก้ตัวละครไม่ได้');
    expect(screen.queryByLabelText('ชื่อจริง')).toBeNull();
    expect(screen.queryByRole('region', { name: 'ของติดตัว' })).toBeNull();
    expect(screen.queryByRole('button', { name: /ถัดไป|ยืนยัน|แก้/ })).toBeNull();
  });

  it('the game starts while the character page is open: the lobby swaps it for the play room', { timeout: 15_000 }, async () => {
    mock(0.25); // the start comes 3 s in
    render(<Lobby apiBaseUrl={base('start-while-creating')} token={MOCK_TOKEN} onSessionLost={noop} pollMs={100} />);
    fireEvent.click(await screen.findByRole('button', { name: 'แก้ตัวละคร' }));
    expect(await screen.findByRole('region', { name: 'ของติดตัว' })).toBeTruthy();

    expect(await screen.findByText('เชื่อมต่อแล้ว', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'ของติดตัว' })).toBeNull();
    expect(screen.queryByText(/ขั้นที่ \d \/ 3/)).toBeNull();
  });
});

describe('C5 nothing forces a 390 px screen to scroll sideways', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pregame.css'), 'utf8');

  it('pregame.css sets no fixed width wider than the screen outside a min-width media query', () => {
    // 390 px minus the 16 px gutters
    const room = 390 - 32;
    const mobile = css.replace(/@media[^{]*min-width[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const fixed = [...mobile.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(mobile.length).toBeLessThan(css.length);
    expect(fixed.filter((px) => px > room)).toEqual([]);
    expect(mobile).not.toMatch(/overflow-x:\s*scroll/);
  });

  it('long words and codes wrap, and inputs never grow past their column', () => {
    expect(css).toMatch(/\.pregame[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.pregame (?:input|:is\([^)]*input[^)]*\))[^{]*\{[^}]*max-width:\s*100%/);
  });
});

describe('C6 a member who joins shows in the lobby without a reload', () => {
  it('lobby-join: ปลา appears in the member list by itself', { timeout: 10_000 }, async () => {
    mock(0.25); // the join comes 1 s in
    render(<Lobby apiBaseUrl={base('lobby-join')} token={MOCK_TOKEN} onSessionLost={noop} pollMs={100} />);
    const list = await screen.findByRole('list', { name: 'สมาชิก' });
    expect(within(list).queryByText('ปลา')).toBeNull();
    expect(screen.getByText('ผู้เล่น 3/6')).toBeTruthy();

    expect(await within(list).findByText('ปลา', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('ผู้เล่น 4/6')).toBeTruthy();
    expect(within(list).getByText('ปลา').closest('li')!.textContent).toContain('ยังไม่สร้างตัวละคร');
  });

  it('every timed answer of a scenario passes the contract schema', () => {
    const failures: string[] = [];
    for (const scenario of SCENARIOS) {
      for (const [key, steps] of Object.entries(scenario.httpScript ?? {})) {
        const item = CONTRACT.filter((c): c is HttpItem => c.kind === 'http').find((c) => routeKey(c) === key);
        if (!item) failures.push(`${scenario.id}: ${key} is not a contract route`);
        for (const { reply } of steps) {
          if (!item || !('status' in reply)) continue;
          const schema = reply.status < 300 ? (item.response ? CONTRACT_SCHEMAS[item.response] : null) : ApiError;
          if (schema && !schema.safeParse(reply.body).success) failures.push(`${scenario.id}: ${key} at ${reply.status}`);
        }
      }
    }
    expect(SCENARIOS.some((s) => s.httpScript)).toBe(true);
    expect(failures).toEqual([]);
  });
});

describe('the origin card after the start (4k)', () => {
  it('shows your own start, as a private card, and closes on เริ่มเล่น', async () => {
    const onClose = vi.fn();
    render(<OriginCard apiBaseUrl={base('normal')} token={MOCK_TOKEN} onClose={onClose} />);
    const card = await screen.findByRole('dialog', { name: 'จุดเกิดของคุณ' });
    expect(await within(card).findByText('ลูกมือล้างจานประจำร้าน')).toBeTruthy();
    await within(card).findByText('เริ่มด้วย');
    expect(card.textContent).toContain('โรงเตี๊ยมและกิลด์นักเดินทาง');
    expect(within(card).getByText('คุณลืมตาขึ้นท่ามกลางกองจานสกปรก…')).toBeTruthy();
    expect(card.textContent).toContain('เห็นคนเดียว');
    expect(card.textContent).toContain('HP 22/30');
    expect(card.textContent).not.toMatch(/หายาก|ลับมาก/);
    // no Karma number, only the word
    expect(card.textContent).toContain('เป็นกลาง');
    fireEvent.click(within(card).getByRole('button', { name: 'เริ่มเล่น' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('origin-rare: a rare start says so in words, and a story still being written says so', async () => {
    render(<OriginCard apiBaseUrl={base('origin-rare')} token={MOCK_TOKEN} onClose={noop} />);
    const card = await screen.findByRole('dialog', { name: 'จุดเกิดของคุณ' });
    expect(await within(card).findByText('หายาก')).toBeTruthy();
    expect(within(card).getByText(/AI กำลังเขียนเรื่องการข้ามโลกของคุณ/)).toBeTruthy();
  });

  it('opens once on the way into the play room, and not again after it was closed', async () => {
    const url = base('normal');
    const { unmount } = render(<Lobby apiBaseUrl={url} token={MOCK_TOKEN} onSessionLost={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    const card = await screen.findByRole('dialog', { name: 'จุดเกิดของคุณ' });
    fireEvent.click(await within(card).findByRole('button', { name: 'เริ่มเล่น' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    unmount();

    render(<Lobby apiBaseUrl={url} token={MOCK_TOKEN} onSessionLost={noop} />);
    fireEvent.click(await screen.findByRole('button', { name: 'เข้าห้องเล่น' }));
    expect(await screen.findByText('เชื่อมต่อแล้ว')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the parts that wait for the backend (GEN-082 / GEN-083) follow the contract schema', () => {
  it('Join: without the flag there is no player code field; with it the code and the opt-out are sent', async () => {
    const { unmount } = render(<JoinForm apiBaseUrl={base('guest')} onJoined={noop} />);
    expect(screen.queryByLabelText(/รหัสผู้เล่น/)).toBeNull();
    unmount();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onJoined = vi.fn();
    render(<JoinForm apiBaseUrl={base('guest')} onJoined={onJoined} pendingFields />);
    type('โค้ดเกม', 'K7Q-2MX');
    type('ชื่อผู้เล่น', 'นก');
    type('PIN', '1234');
    type(/รหัสผู้เล่น/, ' PC-7H2K ');
    fireEvent.click(screen.getByLabelText(/ไม่ต้องเก็บสไตล์ของฉัน/));
    fireEvent.click(button('เข้าร่วม'));

    await waitFor(() => expect(onJoined).toHaveBeenCalled());
    const body = JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body)) as unknown;
    expect(body).toEqual({ inviteCode: 'K7Q-2MX', name: 'นก', pin: '1234', playerCode: 'PC-7H2K', noStyle: true });
  });

  it('Create game: the memory toggle is off by default; on, it lists the games found by the player code', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onCreated = vi.fn();
    render(<CreateGameForm apiBaseUrl={base('guest')} onCreated={onCreated} onBack={noop} pendingFields />);
    type('Create code', 'ลับเฉพาะ');
    type('ชื่อเกม', 'เมืองก่อนอุกกาบาต');
    type('ชื่อผู้เล่นของคุณ', 'นก');
    type('PIN ของคุณ', '1234');

    const toggle = screen.getByRole('switch', { name: 'ความทรงจำจากเกมก่อน' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('ปิดอยู่')).toBeTruthy();
    expect(screen.queryByLabelText(/รหัสผู้เล่นของคุณ/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('เปิดอยู่')).toBeTruthy();

    // on with no game picked: the form says so and cannot be sent
    expect(button('สร้างเกมและรับโค้ด').disabled).toBe(true);
    expect(button('ดูเกมที่ใช้ได้').disabled).toBe(true);
    type(/รหัสผู้เล่นของคุณ/, 'PC-7H2K');
    fireEvent.click(button('ดูเกมที่ใช้ได้'));
    const source = (await screen.findByLabelText(/คืนจันทราโลหิต/)) as HTMLInputElement;
    expect(source.closest('label')!.textContent).toContain('คะแนน 8.6');
    fireEvent.click(source);
    expect(screen.getByText('ตั้งแล้วแก้ไม่ได้หลังเริ่มเกม')).toBeTruthy();

    fireEvent.click(button('สร้างเกมและรับโค้ด'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const post = fetchSpy.mock.calls.find(([input]) => String(input).endsWith('/api/games'))!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({ playerCode: 'PC-7H2K', memory: { enabled: true, sourceGameIds: ['g-old'] } });
  });

  it('Lobby: says whether the memory is on, and from which game', async () => {
    render(<Lobby apiBaseUrl={base('normal')} token={MOCK_TOKEN} onSessionLost={noop} />);
    expect(await screen.findByText('ความทรงจำจากเกมก่อน: เปิด (คืนจันทราโลหิต)')).toBeTruthy();
    cleanup();
    render(<Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} />);
    await screen.findByRole('list', { name: 'สมาชิก' });
    expect(screen.queryByText(/ความทรงจำจากเกมก่อน/)).toBeNull();
  });
});
