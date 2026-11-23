import { z } from 'zod';

/**
 * GEN-149: chat with an NPC at your place, outside the turn (Nok 2026-11-23). A message gets an answer at once
 * and the turn does not move. Each player has `perPeriod` messages per period (default 5, the server owner sets it
 * in the System_Rules row of category `NPC Chat`); a failed answer does not use one. The other players at the
 * place see the talk as room entries (`player` + `npc`), a whisper only the speaker (and the Human GM).
 */

/** Longest chat message, in code points after normalisation. */
export const NPC_CHAT_MAX_LENGTH = 300;
/** Q-309: messages per player per period when the game data says nothing. */
export const NPC_CHAT_DEFAULT_PER_PERIOD = 5;
/** ISK-025: longest NPC reply / turn line a player gets, in code points (`clampReply`). */
export const NPC_REPLY_MAX_LENGTH = 120;

export function clampReply(text: string, max: number = NPC_REPLY_MAX_LENGTH): string {
  void max;
  return text;
}

/** Body of POST /api/game/npc-chat. `npc` = the NPC's `ref` (`NpcView.ref`); `whisper` = only you hear it. */
export const NpcChatRequest = z.strictObject({
  npc: z.string().min(1),
  text: z.string(),
  whisper: z.boolean().default(false),
});
export type NpcChatRequest = z.input<typeof NpcChatRequest>;

/** 200 from GET /api/game/npc-chat: this period's quota. `left` 0 = the send button is off until the next period. */
export const NpcChatStatus = z.strictObject({
  perPeriod: z.number().int().min(0),
  left: z.number().int().min(0),
});
export type NpcChatStatus = z.infer<typeof NpcChatStatus>;

/**
 * 200 from POST /api/game/npc-chat: the NPC's answer as you read it (names you do not know stay aliases), and
 * `suggestion` when you asked for something only an action can do (an item, a threat, a quest): try it as your action.
 */
export const NpcChatResponse = z.strictObject({
  reply: z.string(),
  suggestion: z.string().nullable(),
  status: NpcChatStatus,
});
export type NpcChatResponse = z.infer<typeof NpcChatResponse>;
