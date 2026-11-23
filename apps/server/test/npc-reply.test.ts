// ISK-025: NPC replies are short (1-2 sentences, at most 120 code points) and alive (persona, feeling, reaction, a real detail of here).
import { clampReply, NPC_REPLY_MAX_LENGTH } from '@isekai/protocol';
import { describe, expect, it } from 'vitest';
import { DIALOGUE_BLOCK, estimateTokens, NPC_SPEECH_RULES } from '../src/gm/context.ts';
import { cleanNpcLines } from '../src/gm/npc-lines.ts';
import { NPC_CHAT_BLOCK } from '../src/npc-chat/prompt.ts';

const cps = (s: string) => [...s].length;

describe('ISK-025 C1 the prompts', () => {
  const blocks = { chat: NPC_CHAT_BLOCK.text, dialogue: DIALOGUE_BLOCK.text };

  it('C1: NPC chat and the turn NPC lines both carry the 1-2 sentence / 120 rule, the 4 parts and 2 good examples', () => {
    for (const [name, text] of Object.entries(blocks)) {
      expect(text, name).toContain(NPC_SPEECH_RULES);
      expect(text, name).not.toMatch(/1-3 (short )?sentences|200 characters/);
    }
    expect(NPC_SPEECH_RULES).toMatch(/1-2 sentences, at most 120 characters/);
    for (const part of ['persona', 'feeling', 'reaction', 'detail']) expect(NPC_SPEECH_RULES).toContain(part);
    expect(NPC_SPEECH_RULES).toMatch(/never invent/i);
    const examples = [...NPC_SPEECH_RULES.matchAll(/^Good \(.*?\): (.*)$/gm)].map((m) => m[1]!);
    expect(examples).toHaveLength(2);
    for (const e of examples) expect(cps(e)).toBeLessThanOrEqual(NPC_REPLY_MAX_LENGTH);
    expect(NPC_SPEECH_RULES).toMatchSnapshot();
  });

  it('C7: each prompt grows by at most 200 input tokens (develop: chat 1,587 / dialogue 2,552 characters)', () => {
    expect(estimateTokens(blocks.chat) - estimateTokens('x'.repeat(1_587))).toBeLessThanOrEqual(200);
    expect(estimateTokens(blocks.dialogue) - estimateTokens('x'.repeat(2_552))).toBeLessThanOrEqual(200);
  });
});

describe('ISK-025 clampReply', () => {
  it('C2: 150 code points in 3 sentences: cut after the last sentence end that fits', () => {
    const text = `${'ก'.repeat(49)}. ${'ข'.repeat(49)}. ${'ค'.repeat(47)}.`;
    expect(cps(text)).toBe(150);
    expect(clampReply(text)).toBe(`${'ก'.repeat(49)}. ${'ข'.repeat(49)}.`);
  });

  it('C3: one 150 code point sentence with no end: a grapheme cut with "…", at most 120, no tone mark left hanging', () => {
    const text = 'ก่'.repeat(75);
    const out = clampReply(text);
    expect(cps(out)).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
    const body = out.slice(0, -1);
    expect(text.startsWith(body)).toBe(true);
    expect(/^\p{M}/u.test(text.slice(body.length))).toBe(false);
    expect(cps(body)).toBeLessThanOrEqual(119);
  });

  it('C10: exactly 120 stays; 121 is cut; a ZWJ emoji across the cut is never split', () => {
    const exact = `${'ก'.repeat(59)} ${'ข'.repeat(60)}`;
    expect(cps(exact)).toBe(120);
    expect(clampReply(exact)).toBe(exact);
    const over = `${exact}ค`;
    expect(clampReply(over)).not.toBe(over);
    expect(cps(clampReply(over))).toBeLessThanOrEqual(120);

    const family = '👩‍👩‍👧';
    const text = `${'ก'.repeat(116)}${family}${'ข'.repeat(10)}`;
    const out = clampReply(text);
    expect(cps(out)).toBeLessThanOrEqual(120);
    expect(out).toBe(`${'ก'.repeat(116)}…`);
    // The emoji kept whole when it fits.
    const fits = clampReply(`${'ก'.repeat(110)}${family}${'ข'.repeat(10)}`);
    expect(fits).toBe(`${'ก'.repeat(110)}${family}ขขขข…`);
  });

  it('C11: a first sentence of 130 code points then another: a grapheme cut at 119 + "…"', () => {
    expect(clampReply(`${'ก'.repeat(130)}. ${'ข'.repeat(10)}.`)).toBe(`${'ก'.repeat(119)}…`);
  });

  it('C14: Thai with no punctuation, 140 code points, spaces at 50 and 110: the first 110 code points', () => {
    const text = `${'ก'.repeat(50)} ${'ข'.repeat(59)} ${'ค'.repeat(29)}`;
    expect(cps(text)).toBe(140);
    expect([...text][50]).toBe(' ');
    expect([...text][110]).toBe(' ');
    expect(clampReply(text)).toBe([...text].slice(0, 110).join(''));
  });

  it('a sentence end that would leave under 20 code points is not used: grapheme cut instead', () => {
    expect(clampReply(`${'ก'.repeat(10)} ${'ข'.repeat(130)}`)).toBe(`${'ก'.repeat(10)} ${'ข'.repeat(108)}…`);
  });

  it('a grapheme cut never leaves half a name token', () => {
    const out = clampReply(`${'ก'.repeat(110)}{{n:merchant}}${'ข'.repeat(20)}`);
    expect(out).toBe(`${'ก'.repeat(110)}…`);
  });
});

describe('ISK-025 C12 the turn NPC lines', () => {
  it('C12: a 150 code point line of 3 sentences comes out at most 120, ending a sentence', () => {
    const text = `${'ก'.repeat(49)}! ${'ข'.repeat(49)}? ${'ค'.repeat(47)}.`;
    const out = cleanNpcLines([{ npcId: 'beggar', kind: 'dialogue', text }], { present: new Set(['beggar']), audience: 'public', forbidden: [], cast: new Set() });
    expect(out.map((l) => l.text)).toEqual([`${'ก'.repeat(49)}! ${'ข'.repeat(49)}?`]);
  });
});
