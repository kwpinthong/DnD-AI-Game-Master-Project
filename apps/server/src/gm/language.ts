/**
 * GEN-164: the AI reads its instructions in English (more precise, fewer tokens); everything a player reads stays
 * Thai. Thai examples, game data and player text are never translated. A leaf module: loot / origin import it
 * without the gm/context.ts import cycle.
 */
/** GEN-165: a game-data field as the AI reads it: its English (`loreEn` …) when filled, else the Thai players see. */
export const forAi = (thai: string, en: string | undefined): string => (en?.trim() ? en : thai);

export const THAI_OUTPUT ='Write all player-facing text (narration, dialogue, results) in natural literary Thai, not translated style.';
