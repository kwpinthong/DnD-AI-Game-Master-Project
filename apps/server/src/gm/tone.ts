import type { GameTone } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { PromptBlock } from '../ai/provider.ts';
import type { ForbiddenRule, VoiceAsset } from '../assets/voice.ts';
import type { DbOrTx } from '../db/client.ts';
import { game } from '../db/schema.ts';
import { estimateTokens, STYLE_BLOCK_TOKENS } from './context.ts';

/**
 * GEN-177: the game's tone as a system block. It is the same for every call of a game (the tone is locked at the
 * start), so it sits in the cacheable start of the narration and dialogue prompts, before anything per turn.
 * NPC speech profiles are not here: they are the same in every tone.
 */
export function toneBlock(voice: VoiceAsset, tone: GameTone): PromptBlock {
  const t = voice.tones[tone];
  // GEN-164: the labels are English; the tone's name, description and samples are Voice data and stay Thai.
  const text = [`The language tone of this game: ${t.name}`, t.description, 'NPC lines still follow that NPC\'s own profile', 'Tone samples:', ...t.samples.map((s) => `- ${s}`)].join('\n');
  return { id: 'tone', text, cache: true };
}

const ruleLine = ({ match: m, fix }: ForbiddenRule) =>
  m.type === 'density' ? `- at most ${m.max} of ${m.words.join(' / ')} per ${m.perSentences} sentences: ${fix}` : `- never ${m.type === 'regex' ? `/${m.value}/` : `"${m.value}"`}: ${fix}`;

/**
 * GEN-195: the Voice's forbidden phrases and bad → good pairs, so the rules the owner approves (GEN-178) shape every
 * call, not only the GEN-169 rewrite. Stable per Voice version, so it sits cached right after the tone block. Whole
 * lines are kept in order (block rules, flag rules, pairs) while they fit STYLE_BLOCK_TOKENS.
 */
export function styleBlock(voice: VoiceAsset, scope: 'narration' | 'dialogue'): PromptBlock {
  const rules = voice.forbidden.filter((r) => r.scope === 'all' || r.scope === scope);
  const head = 'Thai style rules (the text must break none of them):';
  const pairHead = 'Bad → good examples:';
  let used = estimateTokens(`${head}\n${pairHead}`);
  const fit = (lines: string[]) =>
    lines.filter((l) => {
      const cost = estimateTokens(l) + 1;
      if (used + cost > STYLE_BLOCK_TOKENS) return false;
      used += cost;
      return true;
    });
  const kept = fit([...rules.filter((r) => r.severity === 'block'), ...rules.filter((r) => r.severity === 'flag')].map(ruleLine));
  const pairs = fit(voice.pairs.map((p) => `- ${p.bad} → ${p.good}`));
  return { id: 'style', text: [head, ...kept, ...(pairs.length > 0 ? [pairHead, ...pairs] : [])].join('\n'), cache: true };
}

export const gameTone = (db: DbOrTx, gameId: string): GameTone => db.select({ tone: game.tone }).from(game).where(eq(game.id, gameId)).get()?.tone ?? 'A';
