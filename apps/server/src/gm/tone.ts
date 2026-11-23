import type { GameTone } from '@isekai/protocol';
import { eq } from 'drizzle-orm';
import type { PromptBlock } from '../ai/provider.ts';
import type { VoiceAsset } from '../assets/voice.ts';
import type { DbOrTx } from '../db/client.ts';
import { game } from '../db/schema.ts';

/**
 * GEN-177: the game's tone as a system block. It is the same for every call of a game (the tone is locked at the
 * start), so it sits in the cacheable start of the narration and dialogue prompts, before anything per turn.
 * NPC speech profiles are not here: they are the same in every tone.
 */
export function toneBlock(voice: VoiceAsset, tone: GameTone): PromptBlock {
  const t = voice.tones[tone];
  const text = [`โทนภาษาของเกมนี้: ${t.name}`, t.description, 'บทพูด NPC ยังตามโปรไฟล์ของ NPC ตัวนั้น', 'ตัวอย่างโทน:', ...t.samples.map((s) => `- ${s}`)].join('\n');
  return { id: 'tone', text, cache: true };
}

export const gameTone = (db: DbOrTx, gameId: string): GameTone => db.select({ tone: game.tone }).from(game).where(eq(game.id, gameId)).get()?.tone ?? 'A';
