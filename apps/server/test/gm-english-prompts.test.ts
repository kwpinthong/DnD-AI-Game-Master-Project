import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { STYLE_REVIEW_INSTRUCTIONS } from '../src/admin/style-review.ts';
import type { VoiceAsset } from '../src/assets/voice.ts';
import { RULES_PROMPT as LOOT_RULES, LootProposal } from '../src/game/loot.ts';
import { RULES_PROMPT as ORIGIN_RULES, OriginNarration } from '../src/game/origin.ts';
import {
  DIALOGUE_BLOCK,
  FINALE_BLOCK,
  JOURNAL_BLOCK,
  NARRATOR_BLOCK,
  NPC_SPEECH_EXAMPLES,
  REPAIR_INSTRUCTION,
  RULES_BLOCK,
  STYLE_REWRITE_INSTRUCTION,
  SUMMARY_BLOCK,
  THAI_OUTPUT,
} from '../src/gm/context.ts';
import { mockNarration } from '../src/gm/mock-gm.ts';
import { AVOID_LEAD, LEARNING_HEADS, LEARNING_LEAD } from '../src/learning/memory.ts';
import { EXAMPLES_HEAD } from '../src/gm/npc-examples.ts';
import { SCENE_BLOCK } from '../src/gm/scene.ts';
import { GmDaySummary, GmDialogue, GmFinale, GmJournal, GmNarration, GmScene, GmTurnProposal } from '../src/gm/schema.ts';
import { styleBlock, toneBlock } from '../src/gm/tone.ts';
import { eventContextBlock } from '../src/timeline/context.ts';
import { EventOutcomeProposal } from '../src/timeline/trigger.ts';
import { WEATHER_RULES } from '../src/weather/service.ts';

/**
 * GEN-164: the AI reads its instructions in English and writes for the players in Thai. The only Thai a
 * system block may keep is this allowlist: words the AI must write as they are (the reader's "คุณ").
 */
// GEN-083: the avoid lead-in of the learning block is Thai by the requirement (GEN-108 R5).
// ISK-025: the NPC reply rules show 2 good replies in Thai and name the word not to write (รู้สึก).
const ALLOWED_THAI = ['คุณ', AVOID_LEAD, ...NPC_SPEECH_EXAMPLES, 'รู้สึก'];
const THAI = /[฀-๿]/;
const thaiLeft = (text: string) => ALLOWED_THAI.reduce((t, word) => t.split(word).join(''), text).match(/[฀-๿]+/g) ?? [];

/** Thai letters / all letters (spaces, digits, punctuation and tokens do not count). */
const thaiRatio = (text: string) => {
  const letters = [...text.replace(/\{\{[pn]:[^}]*\}\}/g, '')].filter((ch) => /\p{L}/u.test(ch));
  return letters.length === 0 ? 0 : letters.filter((ch) => THAI.test(ch)).length / letters.length;
};

const englishVoice = {
  tones: { A: { name: 'Tone A', description: 'plain', samples: ['sample'] } },
  forbidden: [
    { id: 'a', match: { type: 'regex', value: 'x+' }, scope: 'all', severity: 'block', fix: 'fix' },
    { id: 'b', match: { type: 'density', words: ['he'], max: 1, perSentences: 2 }, scope: 'narration', severity: 'flag', fix: 'fix' },
    { id: 'c', match: { type: 'literal', value: 'y' }, scope: 'all', severity: 'flag', fix: 'fix' },
  ],
  pairs: [{ bad: 'bad', good: 'good' }],
} as unknown as VoiceAsset;

const BLOCKS: Record<string, string> = {
  adjudicate: RULES_BLOCK.text,
  narrate: NARRATOR_BLOCK.text,
  npc_dialogue: DIALOGUE_BLOCK.text,
  summarize_day: SUMMARY_BLOCK.text,
  summarize_journal: JOURNAL_BLOCK.text,
  finale: FINALE_BLOCK.text,
  scene: SCENE_BLOCK.text,
  loot: LOOT_RULES,
  origin: ORIGIN_RULES,
  weather: WEATHER_RULES,
  style_review: STYLE_REVIEW_INSTRUCTIONS,
  npc_examples: EXAMPLES_HEAD,
  tone: toneBlock(englishVoice, 'A').text,
  style: styleBlock(englishVoice, 'narration').text,
  timeline: eventContextBlock({ day: 1, phase: 'EOSORIA', active: [], past: [], foreshadowing: [] }).text,
  learning: [LEARNING_LEAD, ...Object.values(LEARNING_HEADS), AVOID_LEAD].join('\n'),
  repair: REPAIR_INSTRUCTION,
  style_rewrite: STYLE_REWRITE_INSTRUCTION,
};

describe('GEN-164 English GM instructions, Thai answers', () => {
  it('C1: every purpose\'s instruction text is English (Thai only from the allowlist)', () => {
    for (const [purpose, text] of Object.entries(BLOCKS)) expect(thaiLeft(text), purpose).toEqual([]);
  });

  it('C1: the answer schemas the AI gets carry no Thai text', () => {
    const schemas = { GmTurnProposal, GmNarration, GmDialogue, GmDaySummary, GmJournal, GmFinale, GmScene, LootProposal, OriginNarration, EventOutcomeProposal };
    for (const [name, schema] of Object.entries(schemas)) expect(JSON.stringify(z.toJSONSchema(schema, { io: 'input' })), name).not.toMatch(THAI);
  });

  it('C2: every block whose answer reaches a player tells the AI to write natural Thai', () => {
    expect(THAI_OUTPUT).toMatch(/natural literary Thai/);
    for (const purpose of ['adjudicate', 'narrate', 'npc_dialogue', 'summarize_day', 'summarize_journal', 'finale', 'scene', 'loot', 'origin']) {
      expect(BLOCKS[purpose], purpose).toContain(THAI_OUTPUT);
    }
  });

  it('C2: a mock narration of Thai beats is Thai (ratio of Thai letters)', () => {
    const value = mockNarration({
      kind: 'gm_narration',
      audience: { player: 'p1' },
      turn: { day: 1, phase: 'EOSORIA', turn: 1 },
      place: { id: 'inn', name: 'โรงเตี๊ยม' },
      cast: [{ ref: 'p1', looks: '', title: 'นักเดินทาง', self: true, karmaBand: 0 }],
      npcs: [],
      answers: [],
      privateLines: false,
      beats: [{ actionId: 'act-1', kind: 'own_action', actor: 'p1', text: '{{p:p1}} มองรอบ ๆ หาเบาะแส', result: 'success', target: null, targetNpc: null, moved: null, items: [] }],
      journal: null,
    });
    for (const s of value.segments) expect(thaiRatio(s.text)).toBeGreaterThan(0.9);
  });
});
