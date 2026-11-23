import type { Period, Weather } from '@isekai/rules';
import { z } from 'zod';
import type { PromptBlock } from '../ai/provider.ts';
import type { NarrationContext } from '../gm/context.ts';

/**
 * GEN-149: the rules of the NPC chat call (purpose `npc_chat`). In its own file, in English, so the GEN-164 rewrite of
 * the GM instructions in gm/context.ts does not collide with it. Cached: it is the same for every chat.
 */
const NPC_CHAT_TEXT = [
  'You are one NPC of a Thai fantasy town, answering a player who talks to you directly, outside the turn. The message JSON gives:',
  '- npc: who you are ({{n:id}} token, public alias, grade, persona, your bond with the player: affinity, met, memories of them; voice: how you speak now).',
  '- player: the player you talk to ({{p:ref}} token and how they look / their social title).',
  '- scene: the place, the day, the period, the weather and who else is here.',
  '- recent: the last lines of your talk with this player (oldest first).',
  '- message: what the player says now. whisper: true = only the two of you hear it.',
  '',
  'Answer as that NPC, in character, in 1-3 short sentences (at most 200 characters).',
  'Reply in natural literary Thai: no translated phrasing, no "ทำการ", no emoji, no markdown.',
  'Never write a real name. Write a person only as a token: {{p:ref}} for a player, {{n:id}} for an NPC (the server fills in the name each reader knows).',
  'Speak only of what this NPC could know: the persona, the memories, the scene. Do not invent events, items or places.',
  '',
  'The chat changes nothing in the world. Only the relationship (mood) and what you remember of the player can change.',
  'If the player asks for something that changes the world (give or sell an item, pay or lend money, fight, threaten, steal, heal, follow them, take or give a quest, move somewhere), answer in character but do not do it.',
  'Then put in `suggestion` one short Thai sentence telling the player to try it as their action this turn. Otherwise `suggestion` is null.',
  '`mood`: how the talk left you about this player: warmer, same or colder.',
].join('\n');

export const NPC_CHAT_BLOCK: PromptBlock = { id: 'npc-chat-rules', text: NPC_CHAT_TEXT, cache: true };

/** What the AI answers. */
export const NpcChatAnswer = z.object({
  reply: z.string().min(1).describe('The NPC answer in Thai, 1-3 sentences, names only as tokens.'),
  suggestion: z.string().nullable().describe('Thai: try it as your action this turn; null unless the player asked for a world effect.'),
  mood: z.enum(['warmer', 'same', 'colder']).describe('How the talk left the NPC about this player.'),
});
export type NpcChatAnswer = z.infer<typeof NpcChatAnswer>;

/** The message JSON of one NPC chat call (what `sendNpcChat` sends; the style eval writes the same shape). */
export interface NpcChatContext {
  npc: { token: string } & NarrationContext['npcs'][number];
  player: { token: string; look: string; socialTitle: string };
  scene: { place: string; day: number; period: Period; weather: Weather | null; playersHere: string[]; npcsHere: string[] };
  recent: { from: 'player' | 'npc'; text: string }[];
  message: string;
  whisper: boolean;
}
