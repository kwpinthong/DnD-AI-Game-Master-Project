// GEN-088 / GEN-122: the Play page (chat style, desktop), every case on the GEN-100 mock scenarios.
import type { CharacterView } from '@isekai/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMock, MOCK_TOKEN, mockBaseUrl, mockRoom } from '../src/mock/install.ts';
import { PlayerBubble } from '../src/play/chat/Bubbles.tsx';
import { PeriodDial } from '../src/play/chat/Hud.tsx';
import { SelfStatus } from '../src/play/SelfColumn.tsx';
import { PlayRoom } from '../src/PlayRoom.tsx';
import { contrast, textPairs } from './contrast.ts';

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

function playRoom(scenario: string, cellName?: string) {
  const baseUrl = mockBaseUrl(scenario, cellName ?? `p${++cell}`);
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
const tab = async (name: string) => fireEvent.click(await screen.findByRole('tab', { name }));
const feedRegion = async () => within(await region('เหตุการณ์ที่นี่'));
const here = dirname(fileURLToPath(import.meta.url));
// CRLF checkouts (core.autocrlf) must not break the exact-selector matches below
const css = (file: string) => readFileSync(join(here, '..', 'src', 'play', file), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (source: string, selector: string) => new RegExp(`(?:^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';

describe('C1 every kind of message, each on its side', () => {
  it('our box right, NPC left with avatar + name, narration / reaction italic without a box, result badges in the centre', async () => {
    playRoom('normal');
    const feed = await feedRegion();
    await feed.findByText('ถ้าเจ้าอยากรู้เรื่องนาฬิกา ก็นั่งลงก่อนสิ');
    // NPC dialogue: left, avatar (grade F ring) + name + box
    const npc = feed.getByText('ถ้าเจ้าอยากรู้เรื่องนาฬิกา ก็นั่งลงก่อนสิ').closest('.chat-row')!;
    expect(npc.className).toContain('chat-row--left');
    expect(npc.querySelector('.chat-avatar--g-f')).toBeTruthy();
    expect(within(npc as HTMLElement).getByText('ลูเซีย')).toBeTruthy();
    // a private line from an NPC whose grade is not sent: neutral ring, and the words say it is for you alone
    const priv = feed.getByText('ข้าเห็นว่าเจ้าไม่ได้มาที่นี่เพื่อน้ำพุเท่านั้น').closest('.chat-row')!;
    expect(priv.querySelector('.chat-avatar--plain')).toBeTruthy();
    expect(within(priv as HTMLElement).getByText('พูดกับคุณคนเดียว')).toBeTruthy();
    // narration + reaction: italic text, no box, no avatar
    for (const text of ['ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง', 'เด็กขอทานเงยหน้ามองแล้วรีบถอยไปชิดกำแพง']) {
      const line = feed.getByText(text);
      expect(line.closest('.chat-narration')).toBeTruthy();
      expect(line.closest('.chat-box')).toBeNull();
      expect(line.closest('.chat-row')).toBeNull();
    }
    // centre badges: the roll and each changed value (coins gained in the amber tone)
    expect(feed.getByText('ทอย 14 · สำเร็จ').closest('.chat-center')).toBeTruthy();
    expect(feed.getByText('แรง −3 · เดินทางข้ามโซน')).toBeTruthy();
    expect(feed.getByText('เหรียญ −5 · ค่าที่พักโรงเตี๊ยม').className).not.toContain('gain');
    expect(feed.getAllByText(/^— .* · เทิร์น \d/).length).toBeGreaterThan(0);
    // our own action goes right, after we send it
    fireEvent.change(await screen.findByLabelText(/^พิมพ์สิ่งที่จะทำ/), { target: { value: 'เล่นพิณใต้ซุ้มประตู' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    const own = (await feed.findByText('เล่นพิณใต้ซุ้มประตู')).closest('.chat-row')!;
    expect(own.className).toContain('chat-row--own');
    expect(within(own as HTMLElement).getByText('คุณ')).toBeTruthy();
  });

  it('another player is a left box with the alias, never a name', () => {
    render(<PlayerBubble alias="ผู้มาเยือนเสื้อคลุมแดง" text="โยนเหรียญลงในหมวกของคุณ" />);
    const row = screen.getByText('โยนเหรียญลงในหมวกของคุณ').closest('.chat-row')!;
    expect(row.className).toContain('chat-row--left');
    expect(within(row as HTMLElement).getByText('ผู้มาเยือนเสื้อคลุมแดง')).toBeTruthy();
    expect(row.querySelector('.chat-avatar--plain')).toBeTruthy();
  });

  it('GEN-116: an NPC line that arrives late sits under its own turn, not at the end', async () => {
    playRoom('late-npc');
    const feed = await feedRegion();
    await feed.findByText('เทิร์นถัดมา: ฝนเริ่มซา');
    const text = (await region('เหตุการณ์ที่นี่')).textContent ?? '';
    const npc = text.indexOf('ถ้าเจ้าอยากรู้เรื่องนาฬิกา');
    expect(npc).toBeGreaterThan(text.indexOf('ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง'));
    expect(npc).toBeLessThan(text.indexOf('เทิร์นถัดมา: ฝนเริ่มซา'));
  });

  it('GEN-116: a new message does not move a reader who has scrolled up; at the bottom it follows', async () => {
    const baseUrl = playRoom('normal');
    const scroller = (await region('เหตุการณ์ที่นี่')).querySelector('.chat-scroll') as HTMLElement;
    // jsdom has no layout: give the box a size to scroll in
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 500 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    (mockRoom(baseUrl) as unknown as { addEntry: (e: object) => void }).addEntry({ kind: 'narration', place: null, text: 'เสียงกระซิบจากเงามืด' });
    await screen.findByText('เสียงกระซิบจากเงามืด');
    expect(scroller.scrollTop).toBe(100);
    scroller.scrollTop = 1500;
    fireEvent.scroll(scroller);
    (mockRoom(baseUrl) as unknown as { addEntry: (e: object) => void }).addEntry({ kind: 'narration', place: null, text: 'อีกประโยค' });
    await screen.findByText('อีกประโยค');
    expect(scroller.scrollTop).toBe(2000);
  });
});

describe('C2 the dial follows the period', () => {
  it.each([
    ['EOSORIA', -67.5, 'เช้า'],
    ['SOLARION', -22.5, 'บ่าย'],
    ['HESPERION', 22.5, 'ค่ำ'],
    ['NOCTHERION', 67.5, 'ดึก'],
  ] as const)('%s: the hand turns to %s degrees and the label names the period', (phase, angle, word) => {
    render(<PeriodDial room={{ day: 2, phase, turn: 1, weather: { weather: 'Rain', disaster: false } }} />);
    const dial = screen.getByRole('img', { name: `วันที่ 2 จาก 12 ช่วง${word} เทิร์น 1 จาก 2 อากาศฝนตก` });
    expect(dial.querySelector('.hud-dial__hand')!.getAttribute('transform')).toBe(`rotate(${angle} 60 60)`);
    expect(dial.querySelectorAll('.hud-dial__slot')).toHaveLength(4);
    expect(dial.querySelectorAll('.hud-dial__slot--now')).toHaveLength(1);
  });

  it('day / period / turn / weather change when the mock moves on, with no reload', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('period-change');
    await region('ห้องเล่น');
    const bar = await waitFor(topBar);
    expect(within(bar).getByText('วันที่ 3/12')).toBeTruthy();
    expect(within(bar).getByText('บ่าย · เทิร์น 1/2')).toBeTruthy();
    expect(within(bar).getByText('ฝนตก')).toBeTruthy();
    expect(within(bar).getByRole('img', { name: /ช่วงบ่าย/ })).toBeTruthy();
    expect(within(bar).getByRole('img', { name: 'ฝนตก' }).getAttribute('src')).toContain('weather-rain'); // GEN-132

    await waitFor(() => expect(within(bar).getByText('บ่าย · เทิร์น 2/2')).toBeTruthy(), { timeout: 3000 });
    await waitFor(() => expect(within(bar).getByText('ค่ำ · เทิร์น 1/2')).toBeTruthy(), { timeout: 3000 });
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

  it('the HUD names the character and how others see them, with HP, Stamina as a word, and coins', async () => {
    playRoom('normal');
    const who = await screen.findByRole('group', { name: 'ตัวละครของคุณ' });
    await within(who).findByText('ลิน');
    expect(who.textContent).toContain('คนอื่นเห็นคุณเป็น: หญิงผ้าคลุมเทา');
    const stats = who.nextElementSibling as HTMLElement;
    expect(stats.textContent).toContain('HP');
    expect(stats.textContent).toMatch(/22\/30/);
    expect(stats.textContent).toContain('แรง');
    expect(stats.textContent).toContain('เหรียญ');
    expect(stats.querySelectorAll('.icon')).toHaveLength(3);
  });
});

describe('C3 / C4 the action bar', () => {
  it('a quick word only prefills the box and sends nothing until [ส่ง]', async () => {
    const baseUrl = playRoom('normal');
    const receive = vi.spyOn(mockRoom(baseUrl), 'receive');
    const input = (await screen.findByLabelText(/^พิมพ์สิ่งที่จะทำ/)) as HTMLInputElement;
    await screen.findByText('เชื่อมต่อแล้ว');
    receive.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'สังเกต' }));
    expect(input.value).toBe('สังเกต');
    fireEvent.click(screen.getByRole('button', { name: 'โจมตี' }));
    expect(input.value).toBe('โจมตี ');
    fireEvent.change(input, { target: { value: 'โจมตี โจรขโมย' } });
    expect(receive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    await waitFor(() => expect(receive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'action', text: 'โจมตี โจรขโมย', visibility: 'public' })));
  });

  it('the eight words are there, each a button of its own', async () => {
    playRoom('normal');
    const group = await screen.findByRole('group', { name: 'แถบ action' });
    expect(within(group).getAllByRole('button').slice(0, 8).map((b) => b.textContent)).toEqual(['พูดคุย', 'สังเกต', 'สืบค้น', 'โจมตี', 'ป้องกัน', 'สวด', 'ลอบเร้น', 'พัก']);
  });

  it('ticking ลับ and sending: our box says ลับ in words', async () => {
    playRoom('normal');
    fireEvent.change(await screen.findByLabelText(/^พิมพ์สิ่งที่จะทำ/), { target: { value: 'ลอบตามนักบวชไป' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'ลับ' }));
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    const own = (await (await feedRegion()).findByText('ลอบตามนักบวชไป')).closest('.chat-row--own') as HTMLElement;
    expect(within(own).getByText('ลับ')).toBeTruthy();
  });
});

describe('C5 the info panel tabs', () => {
  it('switches content, and the arrow keys move between tabs (role=tab)', async () => {
    playRoom('normal');
    await screen.findByRole('tab', { name: 'สถานที่' });
    const names = () => screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names()).toEqual(['สถานที่', 'ตัวฉัน', 'กระเป๋า', 'คนรอบตัว']);
    expect(screen.getByRole('tab', { name: 'สถานที่' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'น้ำพุกลางเมือง' })).toBeTruthy();

    await tab('ตัวฉัน');
    expect(await screen.findByRole('region', { name: 'สถานะของคุณ' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'น้ำพุกลางเมือง' })).toBeNull();
    // details fold: traits, skills, the log of changed values
    expect(screen.getByText('บันทึกค่าที่เปลี่ยน').closest('details')).toBeTruthy();
    expect(screen.getByText(/^สกิล \(/).closest('details')).toBeTruthy();
    await tab('กระเป๋า');
    expect(await screen.findByText(/^เหรียญ: /)).toBeTruthy();
    await tab('คนรอบตัว');
    expect(await screen.findByRole('region', { name: 'คู่หู' })).toBeTruthy();

    const second = screen.getByRole('tab', { name: 'ตัวฉัน' });
    screen.getByRole('tab', { name: 'สถานที่' }).focus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'คนรอบตัว' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'สถานที่' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'สถานที่' }), { key: 'ArrowRight' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'สถานที่' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'สถานที่' }).getAttribute('tabindex')).toBe('0');
    expect(second.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'สถานที่' }).id);
  });
});

describe('C6 locked states: disabled, with the reason in words', () => {
  it.each([
    ['exhausted', 'คุณหมดแรง ต้องพักเทิร์นนี้'],
    ['unconscious', 'คุณสลบ 1 เทิร์น'],
    ['resolving', 'กำลังสรุปผล'],
    ['budget-reached', 'ใช้ครบงบ AI ของเดือนนี้แล้ว'],
  ])('%s', async (scenario, reason) => {
    playRoom(scenario);
    expect((await screen.findAllByText(new RegExp(reason))).length).toBeGreaterThan(0);
    const bar = screen.getByRole('form', { name: 'ส่ง action' });
    expect((within(bar).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect((within(bar).getByRole('button', { name: /^ส่ง/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(bar).getByRole('button', { name: 'สังเกต' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(bar).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('waiting for the turn: the sent action is shown, the box is closed, and it says who we wait for', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('waiting');
    const bar = await waitFor(topBar);
    expect(await within(bar).findByText('ส่งแล้ว 2/3')).toBeTruthy();
    const box = screen.getByRole('form', { name: 'ส่ง action' });
    expect(within(box).getByText('ส่งแล้ว (เปิดเผย): ตามนักบวชไปดูว่าเอาขนมปังมาจากไหน')).toBeTruthy();
    expect(within(box).getByText('รอผู้เล่นอื่น ส่งแล้ว 2/3')).toBeTruthy();
    expect((within(box).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect((await feedRegion()).getByText('ตามนักบวชไปดูว่าเอาขนมปังมาจากไหน').closest('.chat-row--own')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'เมนู' }));
    const members = screen.getByRole('list', { name: 'ผู้เล่นในห้อง' });
    expect(members.textContent).not.toMatch(/ส่งแล้ว|ยังไม่ส่ง/);
    expect(await within(bar).findByText('ส่งแล้ว 3/3', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('the Secret quota is used: only ลับ is closed, with the day it resets', async () => {
    playRoom('secret-used');
    await screen.findByText('เชื่อมต่อแล้ว');
    const box = screen.getByRole('form', { name: 'ส่ง action' });
    expect((within(box).getByRole('checkbox', { name: 'ลับ' }) as HTMLInputElement).disabled).toBe(true);
    expect(within(box).getByText('ใช้ลับวันนี้แล้ว รีเซ็ตเช้าวันที่ 4')).toBeTruthy();
    expect((within(box).getByRole('textbox') as HTMLInputElement).disabled).toBe(false);
  });

  it('Single mode has no counter at all', async () => {
    playRoom('single');
    const bar = await waitFor(topBar);
    await within(bar).findByText('วันที่ 3/12');
    expect((await region('ห้องเล่น')).textContent).not.toMatch(/ส่งแล้ว \d+\/\d+/);
  });
});

describe('C7 / C8 layout, contrast and tap targets (measured in Chrome too; jsdom has no layout)', () => {
  const chat = css('chat/chat.css');
  const play = css('play.css');

  it('feed at most 900 wide centred, info panel 340, the texture on the whole middle area', () => {
    expect(rule(play, '.play')).not.toMatch(/position:\s*fixed/);
    expect(rule(play, '.play')).toMatch(/height:\s*100dvh/);
    expect(rule(chat, '.v3-main')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+340px/);
    expect(rule(chat, '.chat-feed')).toMatch(/max-width:\s*900px/);
    expect(rule(chat, '.chat-feed')).toMatch(/margin:\s*0 auto/);
    expect(rule(chat, '.v3-feed')).toMatch(/radial-gradient/);
    expect(rule(chat, '.v3-feed')).toMatch(/var\(--bg\)/);
  });

  it('the chat sheet names no colour value, and every colour + background pair is a checked pair >= 4.5:1', () => {
    expect(chat).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const tokens = Object.fromEntries([...readFileSync(join(here, '..', 'src', 'tokens.css'), 'utf8').matchAll(/(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]));
    const checked = new Set(textPairs.map(([fg, bg]) => `${fg}|${bg}`));
    const failures: string[] = [];
    for (const m of chat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]!;
      const fg = /(?:^|[;\s])color:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
      const bg = /background(?:-color)?:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
      if (!fg || !bg) continue;
      if (!checked.has(`${fg}|${bg}`)) failures.push(`${m[1]!.trim()}: ${fg} on ${bg} is not in contrast.ts`);
      else if (contrast(tokens[fg]!, tokens[bg]!) < 4.5) failures.push(`${m[1]!.trim()}: ${fg} on ${bg} < 4.5`);
    }
    expect(failures).toEqual([]);
  });

  it('every button, summary and vote button of the frame is at least 44 x 44', () => {
    expect(rule(chat, '.play .v3 button,\n.play .v3 .btn,\n.play .v3 summary')).toMatch(/min-height:\s*44px/);
    expect(chat).toMatch(/\.play \.v3 button,\s*\.play \.v3 \.btn \{\s*min-width: 44px;/);
    expect(rule(chat, '.play .chat-tabs__tab')).toMatch(/min-height:\s*48px/);
    expect(rule(chat, '.play .chat-send')).toMatch(/min-height:\s*48px/);
    expect(rule(chat, '.play .chat-input')).toMatch(/min-height:\s*48px/);
    // small icon-only pills (2356e17): 28px visible + an 8px ::after halo on every side = a 44px tap target
    expect(chat).toMatch(/\.play \.chat-col \.vote-btn \{\s*position: relative;\s*min-height: 28px;\s*min-width: 28px;/);
    expect(chat).toMatch(/\.play \.chat-col \.vote-btn::after \{\s*content: '';\s*position: absolute;\s*inset: -8px;/);
  });
});

describe('C9 ถูกใจ / ไม่ถูกใจ', () => {
  const groupOf = async (text: string) => {
    const feed = await feedRegion();
    const li = (await feed.findByText(text)).closest('li')!;
    return within(li as HTMLElement);
  };
  const SEQ10 = 'ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง';

  it('buttons sit under AI-written text only (narration, NPC dialogue, NPC reaction); not under our box, badges or dividers', async () => {
    playRoom('vote');
    await groupOf(SEQ10);
    const feed = await feedRegion();
    const groups = feed.getAllByRole('group', { name: /AI GM/ });
    expect(groups).toHaveLength(6);
    for (const g of groups) expect(g.closest('.chat-narration, .chat-col')).toBeTruthy();
    expect(feed.queryByText('ทอย 14 · สำเร็จ')!.closest('.chat-center')!.querySelector('.vote-buttons')).toBeNull();
    fireEvent.change(await screen.findByLabelText(/^พิมพ์สิ่งที่จะทำ/), { target: { value: 'เดินดู' } });
    fireEvent.click(screen.getByRole('button', { name: 'ส่ง action' }));
    const own = (await feed.findByText('เดินดู')).closest('li')!;
    expect(own.querySelector('.vote-buttons')).toBeNull();
    // the fallback template text (not the AI's) has none
    expect((await groupOf('ระบบบรรยายแทน AI GM')).queryByRole('group')).toBeNull();
  });

  it('none / up / down states; up twice cancels; down after up switches; the answer survives a reopen of the page', async () => {
    const baseUrl = playRoom('vote', 'v1');
    let box = await groupOf(SEQ10);
    const state = () => [box.getByRole('button', { name: /^ถูกใจ/ }), box.getByRole('button', { name: /^ไม่ถูกใจ/ })].map((b) => b.getAttribute('aria-pressed'));
    expect(state()).toEqual(['false', 'false']);
    expect((await groupOf('ประกาศเช้า: ทหารปิดท่าเรือ')).getByRole('button', { name: /^ถูกใจ/ }).getAttribute('aria-pressed')).toBe('true');
    expect((await groupOf('คุณสังเกตว่านักบวชแจกขนมปังเฉพาะบ้านที่มีเด็ก')).getByRole('button', { name: /^ไม่ถูกใจ/ }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(box.getByRole('button', { name: /^ถูกใจ/ }));
    expect(state()).toEqual(['true', 'false']);
    await waitFor(() => expect((box.getByRole('button', { name: /^ถูกใจ/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(box.getByRole('button', { name: /^ถูกใจ/ }));
    expect(state()).toEqual(['false', 'false']);
    await waitFor(() => expect((box.getByRole('button', { name: /^ถูกใจ/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(box.getByRole('button', { name: /^ถูกใจ/ }));
    await waitFor(() => expect((box.getByRole('button', { name: /^ถูกใจ/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(box.getByRole('button', { name: /^ไม่ถูกใจ/ }));
    expect(state()).toEqual(['false', 'true']);
    await waitFor(() => expect((box.getByRole('button', { name: /^ไม่ถูกใจ/ }) as HTMLButtonElement).disabled).toBe(false));

    // open the page again on the same room: what the server kept comes back with the entry
    cleanup();
    render(<PlayRoom apiBaseUrl={baseUrl} token={MOCK_TOKEN} onBack={noop} onGameList={noop} onNeedCharacter={noop} onSessionLost={noop} />);
    box = await groupOf(SEQ10);
    expect(state()).toEqual(['false', 'true']);
  });

  it('a refusal puts the old state back and says so', async () => {
    const baseUrl = playRoom('vote', 'v2');
    const box = await groupOf(SEQ10);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('/vote') ? Promise.reject(new TypeError('offline')) : real(input, init)));
    try {
      fireEvent.click(box.getByRole('button', { name: /^ถูกใจ/ }));
      expect(await screen.findByText('ให้คะแนนไม่สำเร็จ ลองใหม่อีกครั้ง')).toBeTruthy();
      expect(box.getByRole('button', { name: /^ถูกใจ/ }).getAttribute('aria-pressed')).toBe('false');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(baseUrl).toBeTruthy();
  });

  it('the Human GM scenario has no buttons at all', async () => {
    playRoom('gm');
    await screen.findByRole('region', { name: 'เหตุการณ์ที่นี่' });
    expect(document.querySelector('.vote-buttons')).toBeNull();
  });
});

describe('C3 words, never the hidden numbers', () => {
  it('own status shows karma and reputation as words; bonds and difficulty as words', async () => {
    playRoom('normal');
    await tab('ตัวฉัน');
    const status = await region('สถานะของคุณ');
    const row = (label: string) => within(status).getByText(label).closest('div')!.textContent ?? '';
    await within(status).findByText('ลิน');
    expect(row('กรรม')).toBe('กรรมเป็นกลาง');
    expect(row('ฉายา')).toBe('ฉายาคนคุ้นหน้า');
    expect(row('HP')).toBe('HP22/30ปกติ');
    expect(row('แรง')).toBe('แรง18/30ปกติ');
    expect(row('เหรียญ')).toBe('เหรียญ18');

    await tab('คนรอบตัว');
    const companions = await region('คู่หู');
    const first = (await within(companions).findByText('เด็กชายตัวผอม')).closest('li')!;
    expect(first.textContent).toContain('สนิท');
    expect(first.textContent).toContain('หลัก');
    expect(first.textContent).not.toMatch(/\d/);
    expect(within(first).getByRole('img', { name: 'ความสัมพันธ์ขั้น สนิท' })).toBeTruthy();

    const feed = await feedRegion();
    const factors = (await feed.findByRole('list', { name: 'เหตุของผลทอย' })) as HTMLElement;
    expect(factors.textContent).not.toMatch(/\d/);
    expect(within(factors).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['▲ ช่วย Glare of Truth', '▲ ช่วย ฝนตก: ลอบเร้นง่ายขึ้น', '▼ ถ่วง ง่วงซึม', '? ไม่รู้ ชะตา']);

    const text = (await region('ห้องเล่น')).textContent ?? '';
    expect(text).not.toMatch(/karma|reputation|affinity|modifier|\bDC\b/i);
    expect(text).not.toMatch(/(?:กรรม|ฉายา|ความสัมพันธ์|ความยาก)\s*:?\s*[+-]?\d/);
    expect(text).toContain('ง่วงซึม');
    expect(text).not.toMatch(/d20\s*[+-]\s*\d/);
  });

  it('timed statuses are words (GEN-095), and 0 HP reads สลบ', () => {
    const character: CharacterView = {
      name: 'ลิน',
      appearance: 'หญิงผ้าคลุมเทา',
      personality: '',
      avatarId: null,
      appearanceTraits: null,
      hp: { current: 7, max: 30 },
      stamina: { current: 0, max: 30 },
      coins: 3,
      socialTitle: 'คนแปลกหน้า',
      conduct: 'วายร้ายฝึกหัด',
      statuses: ['หวาดกลัว'],
      strength: null,
      weakness: null,
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

describe('the hit card, the socket, travel and skills', () => {
  it('a hit arrives live, is pinned over the feed, survives the next turn and goes on [รับทราบ] into a line', { timeout: 10_000 }, async () => {
    slowScripts();
    const baseUrl = playRoom('hit');
    await region('เหตุการณ์ที่นี่');
    expect(screen.queryByText('ถุงเงินของคุณหายไป')).toBeNull();
    const card = (await screen.findByText('ถุงเงินของคุณหายไป', {}, { timeout: 3000 })).closest('article')!;
    expect(within(card).getByRole('heading', { name: 'เกิดกับคุณ' })).toBeTruthy();
    expect(card.textContent).toContain('เหรียญ -12');
    expect(card.textContent).toContain('ไม่รู้ว่าใครทำ');
    expect(card.closest('.play-pin')!.compareDocumentPosition(screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    mockRoom(baseUrl).nextTurn();
    await waitFor(() => expect(within(topBar()).getByText('บ่าย · เทิร์น 2/2')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'เกิดกับคุณ' })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'รับทราบ' }));
    expect(screen.queryByRole('heading', { name: 'เกิดกับคุณ' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' })).getByText(/ถุงเงินของคุณหายไป/)).toBeTruthy();
  });

  it('a second hit waits behind the first: "อีก 1 เรื่อง"', async () => {
    const baseUrl = playRoom('normal');
    await region('เหตุการณ์ที่นี่');
    await screen.findByText('เชื่อมต่อแล้ว');
    mockRoom(baseUrl).hit();
    mockRoom(baseUrl).hit();
    expect(await screen.findByText('อีก 1 เรื่อง')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'รับทราบ' }));
    expect(screen.queryByText(/^อีก \d+ เรื่อง$/)).toBeNull();
    expect(screen.getAllByRole('heading', { name: 'เกิดกับคุณ' })).toHaveLength(1);
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
    const omen = screen.getByRole('form', { name: 'ส่งลางสังหรณ์' });
    const text = within(omen).getByLabelText(/^ลางสังหรณ์/) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'ระวังคนสำรวจใต้แท่นบูชา' } });
    fireEvent.click(within(omen).getByRole('button', { name: 'ส่งลางสังหรณ์' }));
    await waitFor(() => expect(receive).toHaveBeenCalledWith(expect.anything(), { type: 'omen', to: 'p-ton', text: 'ระวังคนสำรวจใต้แท่นบูชา' }));
    expect(await within(omen).findByText('ส่งลางสังหรณ์ของคืนนี้แล้ว ส่งได้อีกครั้งช่วง NOCTHERION ของวันที่ 4')).toBeTruthy();
  });

  it('shows the "กำลังเชื่อมต่อใหม่" strip, then the latest state again', { timeout: 10_000 }, async () => {
    slowScripts();
    playRoom('reconnect');
    // the strip is re-mounted when the room frame replaces the loading one: look it up each time
    const status = () => screen.getByRole('status', { name: 'การเชื่อมต่อห้อง' });
    await waitFor(() => expect(status().textContent).toBe('เชื่อมต่อแล้ว'), { timeout: 3000 });
    await waitFor(() => expect(status().textContent).toMatch(/กำลังเชื่อมต่อใหม่/), { timeout: 3000 });
    expect(status().dataset.connection).toBe('reconnecting');
    await waitFor(() => expect(status().textContent).toBe('เชื่อมต่อแล้ว'), { timeout: 4000 });
    const feed = screen.getByRole('region', { name: 'เหตุการณ์ที่นี่' });
    expect(await within(feed).findByText(/ระหว่างที่คุณหลุด/)).toBeTruthy();
    expect(within(feed).getAllByText('ชายผมแดงตะโกนขายยาสมุนไพรเสียงดัง')).toHaveLength(1);
  });

  it('the place tab shows the place, its zone, who is here, and the travel sheet sends a move', async () => {
    const baseUrl = playRoom('normal');
    const receive = vi.spyOn(mockRoom(baseUrl), 'receive');
    expect(await screen.findByRole('heading', { name: 'น้ำพุกลางเมือง' })).toBeTruthy();
    expect(screen.getByText('โซนใจกลางเมือง')).toBeTruthy();
    const people = await screen.findByRole('list', { name: 'คนที่อยู่ที่นี่' });
    await waitFor(() => expect(within(people).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ชายผมแดง ผ้าพันแผล · บาดเจ็บ · คนคุ้นหน้า', 'เด็กชายตัวผอมคุย']));
    // GEN-149: the NPC chip carries [คุย].
    expect(within(people).getByRole('button', { name: 'คุยกับ เด็กชายตัวผอม' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'เดินทาง' }));
    const sheet = await screen.findByRole('dialog', { name: 'เดินทาง' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'ไป โบสถ์' }));
    await waitFor(() => expect(receive).toHaveBeenCalledWith(expect.anything(), { type: 'move', to: 'church' }));
    expect(await screen.findByRole('heading', { name: 'โบสถ์' })).toBeTruthy();
  });

  it('[ใช้] on a skill puts it into the action box', async () => {
    playRoom('normal');
    await tab('ตัวฉัน');
    const panel = await region('ความสามารถและของ');
    const skill = (await within(panel).findByText('Glare of Truth')).closest('li')!;
    expect(skill.textContent).toContain('Rank B');
    expect(skill.textContent).toContain('วันนี้เหลือ 1');
    fireEvent.click(within(skill).getByRole('button', { name: 'ใช้ Glare of Truth' }));
    expect((screen.getByLabelText(/^พิมพ์สิ่งที่จะทำ/) as HTMLInputElement).value).toBe('ใช้ Glare of Truth: ');
  });
});
