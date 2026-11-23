import { z } from 'zod';

/**
 * GEN-080: the instruction text and answer schema of the `learning_extract` call (own file, so the GM prompt files
 * stay untouched). The input is the end-page JSON `learningSourceFor` builds; the answer is Thai.
 */

export const LEARNING_EXTRACT_INSTRUCTIONS = [
  'You turn the end-of-game summary of a finished fantasy TRPG game into knowledge for the AI GM of later games.',
  'Input: JSON of what every player saw on the end page: ending path, each player (a label, the character, outcome, companions, revealed Secret actions, epilogue), the town timeline events, and the players\' rating comments.',
  'NPCs appear as {{n:id}} tokens: keep them as tokens and list their ids in npcIds. Never write a real person\'s name or a player label.',
  '1) lore: 1-5 short Thai legends of what happened to the world, the town and its NPCs (important events, timeline outcomes, the ending), each <= 300 characters, with 1-4 lower-case tags (a-z, 0-9, _).',
  '2) feedback: one Thai note of what the GM should do differently, summarised from the comments as advice, never quoting them; null when there are no comments.',
].join('\n');

export const ExtractAnswer = z.object({
  lore: z
    .array(z.object({ content: z.string().trim().min(1).max(600), tags: z.array(z.string()).max(8).default([]), npcIds: z.array(z.string()).max(6).default([]) }))
    .min(1)
    .max(5),
  feedback: z.object({ content: z.string().trim().min(1).max(600) }).nullable().default(null),
});
export type ExtractAnswer = z.infer<typeof ExtractAnswer>;
