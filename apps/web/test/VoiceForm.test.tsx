import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameDataEditor } from '../src/GameDataEditor.tsx';
import { mockHttp } from '../src/mock/http.ts';
import { scenarioById } from '../src/mock/scenarios.ts';
import { voiceOf } from '../src/VoiceForm.tsx';

// GEN-192: the Voice set (one object, GEN-176) gets a form: forbidden rules (add / edit / delete with their type) and
// each NPC's speech profile, saved through the same game-data API (schema check, backup, audit, undo).

const RULE_REGEX = { id: 'dai_tham_kan', match: { type: 'regex', value: '(ได้)?ทำการ' }, scope: 'all', severity: 'block', fix: 'ตัด ทำการ' };
const RULE_DENSITY = { id: 'pronoun_repeat', match: { type: 'density', words: ['เขา', 'เธอ'], max: 1, perSentences: 2 }, scope: 'narration', severity: 'flag', fix: 'ละประธาน' };
const BEGGAR = {
  register: 'child_polite',
  self: ['ผม'],
  you: { default: 'พี่', wary: 'ท่าน' },
  particles: ['ครับ', 'นะครับ'],
  catchphrases: ['ไม่เป็นไรครับ, ผมชินแล้ว'],
  never: ['คำหยาบ'],
  neverWords: ['ค่ะ', 'เจ้า'],
  note: 'ติดอ่าง',
  // GEN-193 adds more SS forms: the form must keep whatever is here.
  forms: { ss: { register: 'archaic_divine', self: ['ข้า'] }, ss_good: { self: ['เรา'], you: { default: 'ท่าน' } }, ss_evil: { register: 'whisper_mock' } },
};
const AMNESIAC = { register: 'flat', self: [], you: { default: 'เธอ' }, particles: ['มั้ง'], catchphrases: [], never: [], neverWords: [], note: '' };
const VOICE = {
  version: 1,
  tone: 'A',
  tones: { A: { name: 'a', description: 'a', samples: ['a'] } },
  guide: { voice: 'v', register: 'r', length: 'l', use: [] },
  forbidden: [RULE_REGEX, RULE_DENSITY],
  pairs: [{ bad: 'x', good: 'y' }],
  npcs: { beggar: BEGGAR, amnesiac: AMNESIAC },
};

const summary = (canUndo: boolean) => ({ name: 'Voice', file: 'voice.json', records: 0, parts: { forbidden: 2, npcs: 2 }, updatedAt: '2026-11-23T12:00:00.000Z', canUndo });

function fakeServer() {
  const state = { value: VOICE as unknown, history: [] as unknown[] };
  const puts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/admin/game-data')) return Response.json({ sets: [summary(state.history.length > 0)] });
      if (url.endsWith('/api/admin/game-data-audit')) return Response.json({ entries: [] });
      if (url.endsWith('/undo')) state.value = state.history.pop() ?? state.value;
      else if (init?.method === 'PUT') {
        const value = (JSON.parse(String(init.body)) as { value: { forbidden: { match: { type: string; value?: string } }[] } }).value;
        puts.push(value);
        const bad = value.forbidden.findIndex((r) => r.match.type === 'regex' && r.match.value?.includes('(') && !r.match.value.includes(')'));
        if (bad >= 0) return Response.json({ code: 'invalid_input', message: 'ข้อมูลไม่ตรง schema', fields: { [`forbidden[${bad}].match.value`]: 'regex นี้ compile ไม่ได้' } }, { status: 400 });
        state.history.push(state.value);
        state.value = value;
      }
      return Response.json({ set: summary(state.history.length > 0), value: state.value });
    }),
  );
  return { state, puts };
}

async function openVoice() {
  render(<GameDataEditor apiBaseUrl="" token="adm-1" onForbidden={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Voice \(/ }));
  return screen.findByRole('group', { name: 'NPC beggar' });
}
const rule = (n: number) => screen.getByRole('group', { name: new RegExp(`^กฎ ${n}:`) });
const npc = (id: string) => screen.getByRole('group', { name: `NPC ${id}` });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));

describe('Voice form (GEN-192)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('C1: the list and the form show how many rules and NPC profiles the Voice set has', async () => {
    fakeServer();
    render(<GameDataEditor apiBaseUrl="" token="adm-1" onForbidden={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Voice (กฎ 2 · NPC 2)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Voice (กฎ 2 · NPC 2)' }));
    expect(await screen.findByRole('heading', { name: 'คำต้องห้าม (2 กฎ)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'โปรไฟล์พูด NPC (2 ตัว)' })).toBeTruthy();
  });

  it('C2: changing one NPC pronoun saves only that change; SS forms, other profiles and other keys are kept', async () => {
    const server = fakeServer();
    const beggar = await openVoice();
    expect((within(beggar).getByLabelText('สรรพนามแทนตัว (คั่นด้วย ,)') as HTMLInputElement).value).toBe('ผม');
    fireEvent.change(within(beggar).getByLabelText('สรรพนามแทนตัว (คั่นด้วย ,)'), { target: { value: 'หนู, ผม' } });
    save();
    expect(await screen.findByText('บันทึกแล้ว')).toBeTruthy();
    expect(server.puts).toEqual([{ ...VOICE, npcs: { beggar: { ...BEGGAR, self: ['หนู', 'ผม'] }, amnesiac: AMNESIAC } }]);
    // The saved value comes back from the server: undo is offered (the server logged it).
    expect((screen.getByRole('button', { name: 'ย้อนการแก้ล่าสุด (undo)' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('C2: the other profile fields edit too (you, particles, catchphrases one per line, neverWords)', async () => {
    const server = fakeServer();
    await openVoice();
    const a = npc('amnesiac');
    fireEvent.change(within(a).getByLabelText('เรียกผู้เล่น'), { target: { value: 'แก' } });
    fireEvent.change(within(a).getByLabelText('เรียกผู้เล่นเมื่อสนิท'), { target: { value: 'เพื่อน' } });
    fireEvent.change(within(a).getByLabelText('คำลงท้าย (คั่นด้วย ,)'), { target: { value: 'มั้ง, นะ' } });
    fireEvent.change(within(a).getByLabelText('คำติดปาก (บรรทัดละ 1)'), { target: { value: 'ยังไม่ถึงเวลา\nช่างเถอะ, ไปกัน' } });
    fireEvent.change(within(a).getByLabelText('neverWords (คั่นด้วย ,)'), { target: { value: 'ครับ' } });
    // Clearing an optional call-name drops it instead of saving ''.
    fireEvent.change(within(npc('beggar')).getByLabelText('เรียกผู้เล่นเมื่อระวังตัว'), { target: { value: '' } });
    save();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({
      ...VOICE,
      npcs: {
        beggar: { ...BEGGAR, you: { default: 'พี่' } },
        amnesiac: { ...AMNESIAC, you: { default: 'แก', friendly: 'เพื่อน' }, particles: ['มั้ง', 'นะ'], catchphrases: ['ยังไม่ถึงเวลา', 'ช่างเถอะ, ไปกัน'], neverWords: ['ครับ'] },
      },
    });
  });

  it('C2: forbidden rules are added, edited (type switch) and deleted through the same save', async () => {
    const server = fakeServer();
    await openVoice();
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มกฎ' }));
    const added = rule(3);
    fireEvent.change(within(added).getByLabelText('รหัสกฎ (id)'), { target: { value: 'loanword' } });
    fireEvent.change(within(added).getByLabelText('ชนิดกฎ'), { target: { value: 'literal' } });
    fireEvent.change(within(added).getByLabelText('ค่าที่จับ'), { target: { value: 'โอเค' } });
    fireEvent.change(within(added).getByLabelText('ใช้กับ'), { target: { value: 'narration' } });
    fireEvent.change(within(added).getByLabelText('ระดับ'), { target: { value: 'flag' } });
    fireEvent.change(within(added).getByLabelText('วิธีแก้ (hint)'), { target: { value: 'ใช้คำไทย' } });
    // Density rule: words / max / per sentences.
    fireEvent.change(within(rule(2)).getByLabelText('นับได้สูงสุด'), { target: { value: '2' } });
    fireEvent.change(within(rule(2)).getByLabelText('ต่อกี่ประโยค'), { target: { value: '3' } });
    fireEvent.change(within(rule(2)).getByLabelText('คำที่นับ (คั่นด้วย ,)'), { target: { value: 'เขา' } });
    fireEvent.click(within(rule(1)).getByRole('button', { name: 'ลบกฎ 1' }));
    save();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect((server.puts[0] as typeof VOICE).forbidden).toEqual([
      { ...RULE_DENSITY, match: { type: 'density', words: ['เขา'], max: 2, perSentences: 3 } },
      { id: 'loanword', match: { type: 'literal', value: 'โอเค' }, scope: 'narration', severity: 'flag', fix: 'ใช้คำไทย' },
    ]);
    // Switching a rule to density gives it the density fields.
    fireEvent.change(within(rule(2)).getByLabelText('ชนิดกฎ'), { target: { value: 'density' } });
    expect(within(rule(2)).getByLabelText('นับได้สูงสุด')).toBeTruthy();
    expect(within(rule(2)).queryByLabelText('ค่าที่จับ')).toBeNull();
  });

  it('C3: a regex that does not compile shows at that rule input; nothing is saved', async () => {
    const server = fakeServer();
    await openVoice();
    fireEvent.change(within(rule(1)).getByLabelText('ค่าที่จับ'), { target: { value: '(ทำการ' } });
    save();
    const input = within(rule(1)).getByLabelText('ค่าที่จับ');
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toMatch(/compile ไม่ได้/);
    expect(within(rule(2)).getByLabelText('รหัสกฎ (id)').getAttribute('aria-invalid')).not.toBe('true');
    expect(server.state.value).toEqual(VOICE);
    expect(screen.queryByText('บันทึกแล้ว')).toBeNull();
  });

  it('C4: every input and button of the Voice form is labelled; it uses the 44px token styles of the data form', async () => {
    fakeServer();
    await openVoice();
    const form = screen.getByRole('region', { name: 'แก้ Voice' });
    const nameOf = (el: HTMLElement) => ((el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent ?? '').trim() || el.getAttribute('aria-label');
    const controls = [...within(form).getAllByRole('textbox'), ...within(form).getAllByRole('combobox'), ...within(form).getAllByRole('spinbutton'), ...within(form).getAllByRole('button')];
    for (const el of controls) expect(nameOf(el), el.outerHTML).toBeTruthy();
    // The inputs sit in the GEN-172 field class, whose CSS gives 44px and token colours (checked in GameDataForm.test).
    for (const el of controls.filter((c) => c.tagName !== 'BUTTON' && !c.closest('details'))) expect(el.closest('.gdata__field'), el.outerHTML).toBeTruthy();
    const css = readFileSync(join(__dirname, '../src/library.css'), 'utf8').replace(/\r\n/g, '\n');
    const block = css.slice(css.indexOf('/* GEN-147'), css.indexOf('.lib {'));
    expect(block).toMatch(/\.gdata button,\s*\.gdata summary \{[^}]*min-height: 44px/);
    expect(block).toMatch(/\.gdata__field input,\s*\.gdata__field select,\s*\.gdata__field textarea \{[^}]*min-height: 44px/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it('/dev/gallery: the game-data-voice mock scenario lists Voice with its counts and opens a value the form takes', () => {
    const scenario = scenarioById('game-data-voice');
    expect(scenario.id).toBe('game-data-voice');
    expect(scenario.screens).toContain('game-data');
    const list = mockHttp(scenario, { method: 'GET', path: '/api/admin/game-data' }) as { body: { sets: { name: string; parts?: unknown }[] } };
    expect(list.body.sets.find((s) => s.name === 'Voice')?.parts).toEqual({ forbidden: 2, npcs: 1 });
    const set = mockHttp(scenario, { method: 'GET', path: '/api/admin/game-data/Voice' }) as { body: { value: unknown } };
    expect(voiceOf(set.body.value)).toBeDefined();
  });
});
