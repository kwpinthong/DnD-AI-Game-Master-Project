// ISK-007: the avatar grid + appearance chips of character creation (C1-C8, C10) and the avatar in chat / HUD / Lobby (C9),
// on the GEN-100 mock (the contract fixtures; GET /api/appearance-options answers the full chip list).
import { AVATAR_PRESETS, type RoomEntry } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterScreen } from '../src/CharacterScreen.tsx';
import { Lobby } from '../src/Lobby.tsx';
import { installMock, MOCK_TOKEN, mockBaseUrl } from '../src/mock/install.ts';
import { Avatar } from '../src/play/chat/Bubbles.tsx';
import { ChatFeed } from '../src/play/chat/ChatFeed.tsx';
import { CharacterTag } from '../src/play/chat/Hud.tsx';

const noop = () => {};
let uninstall: () => void;
let cell = 0;
const base = (scenario: string) => mockBaseUrl(scenario, `looks${++cell}`);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.restoreAllMocks();
});

const alt = (id: string) => AVATAR_PRESETS.find((p) => p.id === id)!.alt;
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const group = (name: string) => screen.getByRole('group', { name });
const avatars = () => within(group('รูปตัวละคร')).getAllByRole('button');
const pressed = (el: HTMLElement) => within(el).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
const pressedLabel = (category: string) => pressed(group(category)).map((b) => b.textContent);
const chip = (category: string, label: string) => fireEvent.click(within(group(category)).getByRole('button', { name: label }));
const preview = () => group('ตัวอย่างลักษณะภายนอก').textContent ?? '';
const extra = () => screen.getByLabelText('รายละเอียดเพิ่มเติม') as HTMLInputElement;
const type = (label: string, value: string) => {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};
const CATEGORIES = ['สีผม', 'ทรงผม', 'ดวงตา', 'รูปร่าง', 'ชุด', 'จุดเด่น'] as const;

async function open(scenario = 'no-character', more: Partial<Parameters<typeof CharacterScreen>[0]> = {}) {
  const props = { apiBaseUrl: base(scenario), token: MOCK_TOKEN, onBack: noop, onSessionLost: noop, onGameStarted: noop, gameId: 'g-1', ...more };
  const view = render(<CharacterScreen {...props} />);
  await screen.findByLabelText('ชื่อจริง');
  return { ...view, props };
}
const chipsReady = () => screen.findByRole('group', { name: 'สีผม' });
const posts = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([input, init]) => String(input).endsWith('/api/game/character') && ['POST', 'PUT'].includes(String((init as RequestInit | undefined)?.method)));

describe('C1 the page shows 12 avatars and the 6 chip categories; the options load and fail visibly', () => {
  it('12 avatar buttons named by the presets alt, 6 chip groups', async () => {
    await open();
    await chipsReady();
    const buttons = avatars();
    expect(buttons).toHaveLength(12);
    expect(buttons.map((b) => b.querySelector('img')!.getAttribute('alt'))).toEqual(AVATAR_PRESETS.map((p) => p.alt));
    for (const c of CATEGORIES) expect(within(group(c)).getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('loading: a skeleton with its label while the options have not come', async () => {
    await open('looks-loading');
    expect(screen.getByRole('status', { name: 'กำลังโหลดตัวเลือกหน้าตา…' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'สีผม' })).toBeNull();
  });

  it('error: says so with a retry that asks again and then shows the chips', async () => {
    const real = globalThis.fetch;
    let failed = false;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/api/appearance-options') && !failed) {
        failed = true;
        return Promise.reject(new TypeError('offline'));
      }
      return real(input, init);
    });
    await open();
    expect((await screen.findByRole('alert')).textContent).toContain('โหลดตัวเลือกหน้าตาไม่ได้');
    fireEvent.click(button('ลองใหม่'));
    await chipsReady();
    expect(spy.mock.calls.filter(([input]) => String(input).endsWith('/api/appearance-options'))).toHaveLength(2);
  });
});

describe('C2 picking an avatar fills its default chips, leaves extra alone', () => {
  it('avatar-03: only it is pressed; every category holds its defaults; extra unchanged', async () => {
    await open();
    await chipsReady();
    fireEvent.change(extra(), { target: { value: 'ถือย่ามผ้า' } });
    chip('สีผม', 'แดง');
    fireEvent.click(button(alt('avatar-03')));
    expect(pressed(group('รูปตัวละคร')).map((b) => b.querySelector('img')!.alt)).toEqual([alt('avatar-03')]);
    expect(pressedLabel('สีผม')).toEqual(['ดำ']);
    expect(pressedLabel('ทรงผม')).toEqual(['มัดหาง']);
    expect(pressedLabel('ดวงตา')).toEqual(['น้ำตาล']);
    expect(pressedLabel('รูปร่าง')).toEqual(['ผอมสูง']);
    expect(pressedLabel('ชุด')).toEqual(['เกราะหนัง']);
    expect(pressedLabel('จุดเด่น')).toEqual(['แผลเป็นที่แก้ม']);
    expect(extra().value).toBe('ถือย่ามผ้า');
    // the chips can still be changed afterwards
    chip('ดวงตา', 'ฟ้า');
    expect(pressedLabel('ดวงตา')).toEqual(['ฟ้า']);
  });
});

describe('C3 the preview is the protocol sentence', () => {
  it('long, black, blue, tall, traveler, scar', async () => {
    await open();
    await chipsReady();
    chip('ทรงผม', 'ยาว');
    chip('สีผม', 'ดำ');
    chip('ดวงตา', 'ฟ้า');
    chip('รูปร่าง', 'ผอมสูง');
    chip('ชุด', 'ชุดเดินทาง');
    chip('จุดเด่น', 'แผลเป็นที่แก้ม');
    expect(preview()).toContain('ผมยาวสีดำ ดวงตาสีฟ้า รูปร่างผอมสูง สวมชุดเดินทาง มีแผลเป็นที่แก้ม');
  });
});

describe('C4 nothing is sent until every part is chosen, and the missing ones are named', () => {
  it('no avatar and no build: not sent, "ยังไม่เลือกรูป avatar, รูปร่าง"', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await open();
    await chipsReady();
    type('ชื่อจริง', 'ลิน');
    type('บุคลิก', 'ช่างสังเกต พูดน้อย');
    chip('สีผม', 'ดำ');
    chip('ทรงผม', 'ยาว');
    chip('ดวงตา', 'ฟ้า');
    chip('ชุด', 'ชุดเดินทาง');
    chip('จุดเด่น', 'ไม่มี');
    fireEvent.click(button('ถัดไป: ของติดตัว'));
    expect(screen.getByText('ยังไม่เลือกรูป avatar, รูปร่าง')).toBeTruthy();
    expect(posts(spy)).toHaveLength(0);
    expect(screen.getByText('ขั้นที่ 1 / 3')).toBeTruthy();
  });

  it('complete: the body carries avatarId + every chip (+ extra), no appearance text', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await open();
    await chipsReady();
    type('ชื่อจริง', 'ลิน');
    type('บุคลิก', 'ช่างสังเกต พูดน้อย');
    fireEvent.click(button(alt('avatar-03')));
    fireEvent.change(extra(), { target: { value: 'ถือย่ามผ้า' } });
    fireEvent.click(button('ถัดไป: ของติดตัว'));
    expect(await screen.findByText('ขั้นที่ 2 / 3')).toBeTruthy();
    expect(JSON.parse(String((posts(spy)[0]![1] as RequestInit).body))).toEqual({
      name: 'ลิน',
      personality: 'ช่างสังเกต พูดน้อย',
      avatarId: 'avatar-03',
      appearanceTraits: { hairColor: 'black', hairStyle: 'ponytail', eyes: 'brown', build: 'tall', outfit: 'leather', feature: 'scar', extra: 'ถือย่ามผ้า' },
    });
  });
});

describe('C5 the free text stops at 80 code points; the server refusing it shows at that field', () => {
  it('80/80 and no more', async () => {
    await open();
    await chipsReady();
    expect(screen.getByText('0/80')).toBeTruthy();
    fireEvent.change(extra(), { target: { value: 'ก'.repeat(80) } });
    expect(screen.getByText('80/80')).toBeTruthy();
    fireEvent.change(extra(), { target: { value: 'ก'.repeat(81) } });
    expect([...extra().value]).toHaveLength(80);
    expect(screen.getByText('80/80')).toBeTruthy();
  });

  it('extra_forbidden → the message is at the extra field', async () => {
    await open('looks-extra-forbidden');
    await chipsReady();
    type('ชื่อจริง', 'ลิน');
    type('บุคลิก', 'ช่างสังเกต');
    fireEvent.click(button(alt('avatar-03')));
    fireEvent.change(extra(), { target: { value: 'เพื่อนของมัลคอล์ม' } });
    fireEvent.click(button('ถัดไป: ของติดตัว'));
    const field = extra().closest('.field') as HTMLElement;
    expect((await within(field).findByRole('alert')).textContent).toContain('ใส่ชื่อ NPC');
    expect(extra().getAttribute('aria-invalid')).toBe('true');
  });

  it('invalid_trait → the message is at that category', async () => {
    await open('looks-invalid-trait');
    await chipsReady();
    type('ชื่อจริง', 'ลิน');
    type('บุคลิก', 'ช่างสังเกต');
    fireEvent.click(button(alt('avatar-03')));
    fireEvent.click(button('ถัดไป: ของติดตัว'));
    expect((await within(group('รูปร่าง')).findByRole('alert')).textContent).toContain('กรุณาเลือกลักษณะภายนอก');
  });
});

describe('C6 [สุ่ม] picks an avatar and every category, leaves extra alone', () => {
  it('one avatar, one chip per category, extra kept, the sentence shows', async () => {
    await open();
    await chipsReady();
    fireEvent.change(extra(), { target: { value: 'ถือย่ามผ้า' } });
    expect(preview()).not.toContain('ดวงตา');
    fireEvent.click(button('สุ่ม'));
    expect(pressed(group('รูปตัวละคร'))).toHaveLength(1);
    for (const c of CATEGORIES) expect(pressedLabel(c)).toHaveLength(1);
    expect(extra().value).toBe('ถือย่ามผ้า');
    expect(preview()).toMatch(/ดวงตา.*รูปร่าง.*สวม.*ถือย่ามผ้า/);
  });
});

describe('C7 the draft survives a reload and is gone once the character is saved', () => {
  it('reload restores avatar + chips + extra; a successful create removes charDraft:<gameId>', async () => {
    const first = await open();
    await chipsReady();
    fireEvent.click(button(alt('avatar-03')));
    chip('ดวงตา', 'ฟ้า');
    fireEvent.change(extra(), { target: { value: 'ถือย่ามผ้า' } });
    expect(sessionStorage.getItem('charDraft:g-1')).not.toBeNull();
    first.unmount();

    await open();
    await chipsReady();
    expect(pressed(group('รูปตัวละคร')).map((b) => b.querySelector('img')!.alt)).toEqual([alt('avatar-03')]);
    expect(pressedLabel('ดวงตา')).toEqual(['ฟ้า']);
    expect(extra().value).toBe('ถือย่ามผ้า');

    type('ชื่อจริง', 'ลิน');
    type('บุคลิก', 'ช่างสังเกต');
    fireEvent.click(button('ถัดไป: ของติดตัว'));
    expect(await screen.findByText('ขั้นที่ 2 / 3')).toBeTruthy();
    expect(sessionStorage.getItem('charDraft:g-1')).toBeNull();
  });

  it('a storage that throws does not break the page', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await open();
    await chipsReady();
    fireEvent.click(button(alt('avatar-03')));
    expect(pressedLabel('ทรงผม')).toEqual(['มัดหาง']);
  });
});

describe('C8 the keyboard alone can choose everything', () => {
  it('every avatar and chip is a focusable button (Enter / Space press it); arrows move inside a group', async () => {
    await open();
    await chipsReady();
    const all = [...avatars(), ...CATEGORIES.flatMap((c) => within(group(c)).getAllByRole('button'))];
    for (const b of all) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      expect(b.tabIndex).toBe(0);
    }
    const [a1, a2] = avatars();
    a1!.focus();
    fireEvent.keyDown(a1!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(a2);
    fireEvent.keyDown(a2!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(a1);
    fireEvent.keyDown(a1!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(avatars().at(-1));

    const hair = within(group('ทรงผม')).getAllByRole('button');
    hair[0]!.focus();
    fireEvent.keyDown(hair[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(hair[1]);
  });
});

describe('C9 the avatar shows in chat, HUD and Lobby; no avatar or a broken image = the first letter', () => {
  it('Avatar: an avatarId draws the preset picture; none, an unknown id, or a load error draws the letter', () => {
    const { container, rerender } = render(<Avatar name="ลิน" avatarId="avatar-03" own />);
    const img = container.querySelector('.chat-avatar__face') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('avatar-03');
    expect(container.textContent).toBe('');
    fireEvent.error(img);
    expect(container.querySelector('.chat-avatar__face')).toBeNull();
    expect(container.textContent).toBe('ล');
    rerender(<Avatar name="บาส" avatarId={null} />);
    expect(container.querySelector('.chat-avatar__face')).toBeNull();
    expect(container.textContent).toBe('บ');
    rerender(<Avatar name="ชาย" avatarId="avatar-99" />);
    expect(container.textContent).toBe('ช');
  });

  it('chat: another player we do not know and our own action both show their picture', () => {
    const entry: RoomEntry = { seq: 21, kind: 'player', day: 1, phase: 'EOSORIA', turn: 1, place: { id: 'fountain', name: 'น้ำพุ' }, text: 'โยนเหรียญ', actor: { name: 'คนแปลกหน้า', avatarId: 'avatar-05' } };
    const old: RoomEntry = { ...entry, seq: 22, text: 'เดินผ่าน', actor: { name: 'ผู้มาเยือน' } };
    const { container } = render(
      <ChatFeed entries={[entry, old]} placeId="fountain" astral={false} ownAction={{ text: 'ดูรอบ ๆ', visibility: 'public', rest: false }} self={{ name: 'ลิน', avatarId: 'avatar-03' }} />,
    );
    const faces = [...container.querySelectorAll('.chat-avatar__face')].map((i) => i.getAttribute('src'));
    expect(faces.some((s) => s?.includes('avatar-05'))).toBe(true);
    expect(faces.some((s) => s?.includes('avatar-03'))).toBe(true);
    // the player with no avatarId (made before ISK-006) keeps the letter
    const oldRow = screen.getByText('เดินผ่าน').closest('.chat-row')!;
    expect(oldRow.querySelector('.chat-avatar')!.textContent).toBe('ผ');
  });

  it('HUD: the character tag shows our picture', () => {
    const { container } = render(<CharacterTag character={{ name: 'ลิน', appearance: 'ผมยาว', avatarId: 'avatar-03' }} />);
    expect(container.querySelector('.chat-avatar__face')!.getAttribute('src')).toContain('avatar-03');
  });

  it('Lobby: our own row shows our picture', async () => {
    render(<Lobby apiBaseUrl={base('lobby')} token={MOCK_TOKEN} onSessionLost={noop} />);
    const list = await screen.findByRole('list', { name: 'สมาชิก' });
    const own = within(list).getByText('(คุณ)').closest('li')!;
    await waitFor(() => expect(own.querySelector('.chat-avatar__face')?.getAttribute('src')).toContain('avatar-03'));
  });
});

describe('C10 a 390 px screen: 4 avatar columns, chips wrap, nothing scrolls sideways, every control ≥ 44 px', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pregame.css'), 'utf8');
  const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('the avatar grid has 4 columns at phone width, the chip rows wrap, buttons are 44 px or more', () => {
    expect(rule('.looks__avatars')).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(rule('.looks__chips')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.looks__chip')).toMatch(/min-height:\s*44px/);
    expect(rule('.looks__chip')).toMatch(/min-width:\s*44px/);
    expect(rule('.looks__avatar')).toMatch(/min-height:\s*44px/);
    expect(rule('.looks__avatar')).toMatch(/min-width:\s*0/);
  });
});
