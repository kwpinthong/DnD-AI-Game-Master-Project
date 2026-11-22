// GEN-088: Play screen v2 (desktop 1366×768), every case on the GEN-100 mock scenarios.
import type { CharacterView } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMock, MOCK_TOKEN, mockBaseUrl, mockRoom } from '../src/mock/install.ts';
import { SelfStatus } from '../src/play/SelfColumn.tsx';
import { PlayRoom } from '../src/PlayRoom.tsx';

const noop = () => {};
let uninstall: () => void;
let cell = 0;

beforeEach(() => {
  localStorage.clear();
  uninstall = installMock({ timeScale: 0.01, latencyMs: 0 });
});
afterEach(() => {
  cleanup();
  uninstall();
});

function playRoom(scenario: string) {
  const baseUrl = mockBaseUrl(scenario, `p${++cell}`);
  render(<PlayRoom apiBaseUrl={baseUrl} token={MOCK_TOKEN} onBack={noop} onGameList={noop} onNeedCharacter={noop} onSessionLost={noop} />);
  return baseUrl;
}
/** Scripts at half speed, so the state before the first step can be checked (Learnings GEN-100). */
function slowScripts() {
  uninstall();
  uninstall = installMock({ timeScale: 0.5, latencyMs: 0 });
}
const topBar = () => screen.getByRole('group', { name: 'เวลาและสถานะเกม' });
const region = (name: string | RegExp) => screen.findByRole('region', { name });

describe('C1 everything in one 1366×620 view', () => {
  it('feed, private narration, own status and the action box are on the page at the same time', async () => {
    playRoom('normal');
    const play = await region('ห้องเล่น');
    const feed = await within(play).findByRole('region', { name: 'เหตุการณ์ที่นี่' });
    const story = within(play).getByRole('region', { name: 'เรื่องของคุณ' });
    const status = await within(play).findByRole('region', { name: 'สถานะของคุณ' });
    const action = within(play).getByRole('form', { name: 'ส่ง action' });
    expect(within(feed).getByText('ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง')).toBeTruthy();
    expect(within(story).getByText('คุณสังเกตว่านักบวชแจกขนมปังเฉพาะบ้านที่มีเด็ก')).toBeTruthy();
    expect(await within(status).findByText('ลิน')).toBeTruthy();
    expect(within(action).getByRole('button', { name: 'ส่ง action' })).toBeTruthy();
    // the three columns of P1 (Q-199): self, place (public), private
    expect([...play.querySelectorAll('.play-body > *')].map((c) => c.className)).toEqual(['play-self', 'play-place', 'play-private']);
  });

  it('layout: top bar 44 + three columns 272 / rest / 340 that fill the viewport, nothing scrolls sideways', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'play', 'play.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string, from = css) => new RegExp(`(?:^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(from)?.[1] ?? '';
    // Q-265: its own page, no longer fixed over the app header
    expect(rule('.play')).not.toMatch(/position:\s*fixed/);
    expect(rule('.play')).toMatch(/height:\s*100dvh/);
    expect(rule('.play')).toMatch(/overflow:\s*hidden/);
    // 1366 wide: 272 + 754 + 340; 620 high: 44 + 576 (Screens and Flows v2 4.0)
    const wide = /@container\s+play\s*\(min-width:\s*1280px\)\s*\{([\s\S]*)$/.exec(css)?.[1] ?? '';
    expect(rule('.play-frame')).toMatch(/height:\s*100%/);
    expect(rule('.play-frame', wide)).toMatch(/overflow:\s*hidden/);
    expect(rule('.play-top', wide)).toMatch(/height:\s*44px/);
    expect(rule('.play-body', wide)).toMatch(/grid-template-columns:\s*272px\s+minmax\(0,\s*1fr\)\s+340px/);
    expect(rule('.play-body', wide)).toMatch(/flex:\s*1;[\s\S]*min-height:\s*0;[\s\S]*overflow:\s*hidden/);
    expect(272 + 754 + 340).toBe(1366);
  });
});

describe('C2 the top bar follows the time', () => {
  it('day / period / turn / weather change when the mock moves on, with no reload', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('period-change');
    await region('ห้องเล่น');
    const bar = await waitFor(topBar);
    expect(within(bar).getByText('วันที่ 3/12')).toBeTruthy();
    const now = () => within(bar).getByRole('listitem', { current: 'step' }).textContent ?? '';
    expect(now()).toContain('SOLARION');
    expect(now()).toContain('เทิร์น 1/2');
    expect(now()).toContain('ตอนนี้');
    expect(within(bar).getByText('ฝนตก')).toBeTruthy();
    expect(within(bar).getAllByRole('listitem').map((li) => li.textContent?.replace(/[^A-Z]/g, ''))).toEqual(['EOSORIA', 'SOLARION', 'HESPERION', 'NOCTHERION']);

    await waitFor(() => expect(now()).toContain('เทิร์น 2/2'), { timeout: 3000 });
    await waitFor(() => expect(now()).toContain('HESPERION'), { timeout: 3000 });
    expect(now()).toContain('เทิร์น 1/2');
    expect(within(bar).queryByText('ฝนตก')).toBeNull();
    expect(within(bar).getByText('หมอกจัด')).toBeTruthy();
  });

  it('from day 5 the disaster is named next to the weather', async () => {
    const baseUrl = playRoom('normal');
    const bar = await waitFor(topBar);
    const server = mockRoom(baseUrl);
    for (let i = 0; i < 14; i++) server.nextTurn();
    await waitFor(() => expect(within(bar).getByText('วันที่ 5/12')).toBeTruthy());
    expect(within(bar).getByText(/· ภัยพิบัติ$/)).toBeTruthy();
  });
});

describe('C3 words, never the hidden numbers', () => {
  it('own status shows karma and reputation as words; bonds and difficulty as words', async () => {
    playRoom('normal');
    const status = await region('สถานะของคุณ');
    const row = (label: string) => within(status).getByText(label).closest('div')!.textContent ?? '';
    await within(status).findByText('ลิน');
    expect(row('กรรม')).toBe('กรรมเป็นกลาง');
    expect(row('ฉายา')).toBe('ฉายาคนคุ้นหน้า');
    // own HP / Stamina / coins are numbers the owner may see, with the injury word by fraction of Max HP (Q-197)
    expect(row('HP')).toBe('HP22/30ปกติ');
    expect(row('แรง')).toBe('แรง18/30ปกติ');
    expect(row('เหรียญ')).toBe('เหรียญ18');

    const companions = await region('คู่หู');
    const first = (await within(companions).findByText('เด็กชายตัวผอม')).closest('li')!;
    expect(first.textContent).toContain('สนิท');
    expect(first.textContent).toContain('หลัก');
    expect(first.textContent).not.toMatch(/\d/);
    expect(within(first).getByRole('img', { name: 'ความสัมพันธ์ขั้น สนิท' })).toBeTruthy();

    const story = screen.getByRole('region', { name: 'เรื่องของคุณ' });
    expect(within(story).getByText('ทอย d20 = 14 · ยาก · สำเร็จ')).toBeTruthy();
    fireEvent.click(within(story).getByRole('button', { name: 'ดูเหตุ' }));
    const factors = within(story).getByRole('list', { name: 'เหตุของผลทอย' });
    expect(factors.textContent).not.toMatch(/\d/);
    expect(within(factors).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '▲ ช่วย Glare of Truth',
      '▲ ช่วย ฝนตก: ลอบเร้นง่ายขึ้น',
      '▼ ถ่วง ง่วงซึม',
      '? ไม่รู้ ชะตา',
    ]);

    const text = (await region('ห้องเล่น')).textContent ?? '';
    expect(text).not.toMatch(/karma|reputation|affinity|modifier|\bDC\b/i);
    expect(text).not.toMatch(/(?:กรรม|ฉายา|ความสัมพันธ์|ความยาก)\s*:?\s*[+-]?\d/);
    // the Drowsy note says what it does in words, not the d20 change
    expect(text).toContain('ง่วงซึม');
    expect(text).not.toMatch(/d20\s*[+-]\s*\d/);
  });

  it('timed statuses are words (GEN-095), and 0 HP reads สลบ', () => {
    const character: CharacterView = {
      name: 'ลิน',
      appearance: 'หญิงผ้าคลุมเทา',
      personality: '',
      hp: { current: 7, max: 30 },
      stamina: { current: 0, max: 30 },
      coins: 3,
      socialTitle: 'คนแปลกหน้า',
      conduct: 'วายร้ายฝึกหัด',
      statuses: ['หวาดกลัว'],
      editable: false,
    };
    const { rerender } = render(<SelfStatus character={character} secret="วันนี้เหลือ 1" drowsy />);
    const chips = screen.getByRole('list', { name: 'สถานะ' });
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['หวาดกลัว', 'ง่วงซึม']);
    expect(screen.getByText('สาหัส')).toBeTruthy();
    expect(screen.getByText('หมดแรง')).toBeTruthy();
    expect(screen.getByText('วายร้ายฝึกหัด')).toBeTruthy();
    rerender(<SelfStatus character={{ ...character, hp: { current: 0, max: 30 } }} secret="วันนี้เหลือ 1" drowsy={false} />);
    expect(screen.getByText('สลบ')).toBeTruthy();
  });
});

describe('C4 the hit card stays pinned until acknowledged', () => {
  it('arrives live, sits above the private story, survives the next turn and goes on [รับทราบ]', { timeout: 10_000 }, async () => {
    slowScripts();
    const baseUrl = playRoom('hit');
    const story = await region('เรื่องของคุณ');
    expect(screen.queryByText('ถุงเงินของคุณหายไป')).toBeNull();

    const card = (await screen.findByText('ถุงเงินของคุณหายไป', {}, { timeout: 3000 })).closest('article')!;
    expect(within(card).getByRole('heading', { name: 'เกิดกับคุณ' })).toBeTruthy();
    expect(card.textContent).toContain('เหรียญ -12');
    expect(card.textContent).toContain('ของที่หาย: Prism of Truth');
    expect(card.textContent).toContain('ไม่รู้ว่าใครทำ');
    // pinned: inside the private column, before the story
    const column = screen.getByRole('complementary', { name: 'ส่วนตัว เห็นคนเดียว' });
    expect(column.contains(card)).toBe(true);
    expect(card.compareDocumentPosition(story) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(story).queryByText('ถุงเงินของคุณหายไป')).toBeNull();

    mockRoom(baseUrl).nextTurn();
    await waitFor(() => expect(within(topBar()).getByRole('listitem', { current: 'step' }).textContent).toContain('เทิร์น 2/2'));
    expect(screen.getByRole('heading', { name: 'เกิดกับคุณ' })).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'รับทราบ' }));
    expect(screen.queryByRole('heading', { name: 'เกิดกับคุณ' })).toBeNull();
    // it stays in the story as a line
    expect(within(story).getByText('ถุงเงินของคุณหายไป')).toBeTruthy();
  });

  it('a second hit waits behind the first: "อีก 1 เรื่อง"', async () => {
    const baseUrl = playRoom('normal');
    await region('เรื่องของคุณ');
    await screen.findByText('เชื่อมต่อแล้ว');
    mockRoom(baseUrl).hit();
    mockRoom(baseUrl).hit();
    expect(await screen.findByText('อีก 1 เรื่อง')).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'เกิดกับคุณ' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'รับทราบ' }));
    expect(screen.queryByText(/^อีก \d+ เรื่อง$/)).toBeNull();
    expect(screen.getAllByRole('heading', { name: 'เกิดกับคุณ' })).toHaveLength(1);
  });
});

describe('C5 locked states say why and when it ends', () => {
  const box = () => screen.getByRole('form', { name: 'ส่ง action' });

  it('exhausted: the box is closed with the reason and the turn you are back', async () => {
    playRoom('exhausted');
    const note = await screen.findByRole('note', { name: 'หมดแรง' });
    expect(note.textContent).toContain('คุณหมดแรง ต้องพักเทิร์นนี้');
    expect(note.textContent).toContain('ส่ง action ได้อีกครั้ง: SOLARION เทิร์น 2');
    expect((within(box()).getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect((within(box()).getByRole('button', { name: 'ส่ง action' }) as HTMLButtonElement).disabled).toBe(true);
    // the status column agrees with the lock
    expect(await within(await region('สถานะของคุณ')).findByText('หมดแรง')).toBeTruthy();
  });

  it('unconscious: closed, with the clinic and how long', async () => {
    playRoom('unconscious');
    const note = await screen.findByRole('note', { name: 'สลบ' });
    expect(note.textContent).toContain('คุณสลบ 1 เทิร์น');
    expect(note.textContent).toMatch(/พักฟื้น 2 เทิร์น/);
    expect((within(box()).getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('the Secret quota is used: only ลับ is closed, with the day it resets', async () => {
    playRoom('secret-used');
    await screen.findByText('เชื่อมต่อแล้ว');
    const secret = within(box()).getByRole('radio', { name: 'ลับ' }) as HTMLInputElement;
    expect(secret.disabled).toBe(true);
    expect((within(box()).getByRole('radio', { name: 'เปิดเผย' }) as HTMLInputElement).checked).toBe(true);
    expect(within(box()).getByText('ใช้ลับวันนี้แล้ว รีเซ็ตเช้าวันที่ 4')).toBeTruthy();
    expect((within(box()).getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
    expect(await within(await region('สถานะของคุณ')).findByText('ใช้แล้ว รีเซ็ตเช้าวันที่ 4')).toBeTruthy();
  });

  it('Astral Spirit (Q-192, Q-193): every place read-only, and one omen to one player', async () => {
    const baseUrl = playRoom('astral');
    const receive = vi.spyOn(mockRoom(baseUrl), 'receive');
    expect(await screen.findByText('ลินเป็น Astral Spirit ตั้งแต่วันที่ 6 HESPERION')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'ส่ง action' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'เดินทาง' })).toBeNull();

    const feed = screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' });
    expect(within(feed).getByText('อ่านอย่างเดียว')).toBeTruthy();
    const places = within(feed).getByLabelText('ดูสถานที่') as HTMLSelectElement;
    expect([...places.options].map((o) => o.textContent)).toEqual(['ทุกสถานที่', 'น้ำพุกลางเมือง']);
    expect(within(feed).getByText('ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง')).toBeTruthy();

    const omen = screen.getByRole('form', { name: 'ส่งลางสังหรณ์' });
    const to = within(omen).getByLabelText('ส่งถึง (1 คน)') as HTMLSelectElement;
    expect([...to.options].map((o) => o.textContent)).toEqual(['ชายผมแดง ผ้าพันแผล']);
    const text = within(omen).getByLabelText(/^ลางสังหรณ์/) as HTMLTextAreaElement;
    expect(text.maxLength).toBe(200);
    fireEvent.change(text, { target: { value: 'ระวังคนสำรวจใต้แท่นบูชา' } });
    fireEvent.click(within(omen).getByRole('button', { name: 'ส่งลางสังหรณ์' }));
    await waitFor(() => expect(receive).toHaveBeenCalledWith(expect.anything(), { type: 'omen', to: 'p-ton', text: 'ระวังคนสำรวจใต้แท่นบูชา' }));
    // once a night: closed with when it opens again
    expect(await within(omen).findByText('ส่งลางสังหรณ์ของคืนนี้แล้ว ส่งได้อีกครั้งช่วง NOCTHERION ของวันที่ 4')).toBeTruthy();
    expect((within(omen).getByRole('button', { name: 'ส่งลางสังหรณ์' }) as HTMLButtonElement).disabled).toBe(true);
    expect(text.disabled).toBe(true);
  });
});

describe('C6 waiting for the others', () => {
  it('shows only "ส่งแล้ว n/N", never who', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('waiting');
    const bar = await waitFor(topBar);
    expect(await within(bar).findByText('ส่งแล้ว 2/3')).toBeTruthy();
    const box = screen.getByRole('form', { name: 'ส่ง action' });
    expect(within(box).getByText('ส่งแล้ว (เปิดเผย): ตามนักบวชไปดูว่าเอาขนมปังมาจากไหน')).toBeTruthy();
    expect(within(box).getByText('รอผู้เล่นอื่น ส่งแล้ว 2/3')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'เมนู' }));
    const members = screen.getByRole('list', { name: 'ผู้เล่นในห้อง' });
    expect(within(members).getAllByRole('listitem')).toHaveLength(3);
    expect(members.textContent).not.toMatch(/ส่งแล้ว|ยังไม่ส่ง/);
    expect((await region('ห้องเล่น')).textContent).not.toMatch(/ยังไม่ส่ง/);

    expect(await within(bar).findByText('ส่งแล้ว 3/3', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('Single mode has no counter at all', async () => {
    playRoom('single');
    const bar = await waitFor(topBar);
    await within(bar).findByText('วันที่ 3/12');
    expect((await region('ห้องเล่น')).textContent).not.toMatch(/ส่งแล้ว \d+\/\d+/);
  });
});

describe('C7 the socket drops', () => {
  it('shows the "กำลังเชื่อมต่อใหม่" strip, then the latest state again', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('reconnect');
    const status = await screen.findByRole('status', { name: 'การเชื่อมต่อห้อง' });
    await waitFor(() => expect(status.textContent).toBe('เชื่อมต่อแล้ว'));
    expect(status.className).toContain('sr-only');

    await waitFor(() => expect(status.textContent).toMatch(/กำลังเชื่อมต่อใหม่/), { timeout: 3000 });
    expect(status.className).not.toContain('sr-only');
    expect(status.dataset.connection).toBe('reconnecting');

    await waitFor(() => expect(status.textContent).toBe('เชื่อมต่อแล้ว'), { timeout: 4000 });
    expect(status.className).toContain('sr-only');
    const feed = screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' });
    expect(await within(feed).findByText(/ระหว่างที่คุณหลุด/)).toBeTruthy();
    // what was there before the drop is still there, once
    expect(within(feed).getAllByText('ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง')).toHaveLength(1);
    expect(within(topBar()).getByText('วันที่ 3/12')).toBeTruthy();
  });
});

describe('the place: who is here and travel', () => {
  it('shows the place, its zone, who is here as chips, and the travel sheet sends a move', async () => {
    const baseUrl = playRoom('normal');
    const receive = vi.spyOn(mockRoom(baseUrl), 'receive');
    expect(await screen.findByRole('heading', { name: 'น้ำพุกลางเมือง' })).toBeTruthy();
    expect(screen.getByText('โซนใจกลางเมือง')).toBeTruthy();
    const here = await screen.findByRole('list', { name: 'คนที่อยู่ที่นี่' });
    await waitFor(() => expect(within(here).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ชายผมแดง ผ้าพันแผล · บาดเจ็บ · คนคุ้นหน้า', 'เด็กชายตัวผอม']));

    fireEvent.click(screen.getByRole('button', { name: 'เดินทาง' }));
    const sheet = await screen.findByRole('dialog', { name: 'เดินทาง' });
    expect(await within(sheet).findByText('โซนเดียวกัน: ถึงทันที แรง -1 ยังส่ง action เทิร์นนี้ได้')).toBeTruthy();
    expect(within(sheet).getByText('ข้ามโซน: ใช้ทั้งเทิร์นนี้ แรง -3 ถึงเมื่อจบเทิร์น')).toBeTruthy();
    expect(within(sheet).getByText(/เขตหวงห้าม/)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'แทรกซึม โบสถ์ (ชั้นใต้ดิน)' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'ไป โบสถ์' }));
    await waitFor(() => expect(receive).toHaveBeenCalledWith(expect.anything(), { type: 'move', to: 'church' }));
    expect(await screen.findByRole('heading', { name: 'โบสถ์' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'เดินทาง' })).toBeNull();
  });
});

describe('skills and items', () => {
  it('lists them with rank and uses left, and [ใช้] puts the skill into the action box', async () => {
    playRoom('normal');
    const panel = await region('ความสามารถและของ');
    const skill = (await within(panel).findByText('Glare of Truth')).closest('li')!;
    expect(skill.textContent).toContain('Rank B');
    expect(skill.textContent).toContain('วันนี้เหลือ 1');
    expect((await within(panel).findByText('Prism of Truth')).closest('li')!.textContent).toContain('Passive');
    fireEvent.click(within(skill).getByRole('button', { name: 'ใช้ Glare of Truth' }));
    const box = screen.getByRole('form', { name: 'ส่ง action' });
    expect((within(box).getByRole('textbox') as HTMLTextAreaElement).value).toBe('ใช้ Glare of Truth: ');
  });
});
