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

/** Characters a sentence may end on (cut after them); any whitespace also ends one (cut before it). */
const SENTENCE_END = /[.!?…ฯ”"]/u;
/** A sentence cut that keeps fewer code points than this is worse than a grapheme cut. */
const MIN_SENTENCE_CUT = 20;
const GRAPHEMES = new Intl.Segmenter('th', { granularity: 'grapheme' });

/**
 * ISK-025: an NPC reply / turn line as a player gets it. At most `max` code points: unchanged; longer: cut at the last
 * sentence end within `max` that keeps at least 20; none: whole graphemes up to `max - 1` and "…" (never splits an
 * emoji, a ZWJ sequence or a Thai tone mark, never ends on a vowel written before its consonant or half a {{token}}).
 */
export function clampReply(text: string, max: number = NPC_REPLY_MAX_LENGTH): string {
  const cps = [...text];
  if (cps.length <= max) return text;
  for (let n = max; n >= MIN_SENTENCE_CUT; n--) {
    if (SENTENCE_END.test(cps[n - 1]!) || /\s/u.test(cps[n]!)) return cps.slice(0, n).join('').trimEnd();
  }
  let body = '';
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    used += [...segment].length;
    if (used > max - 1) break;
    body += segment;
  }
  return `${body.replace(/\{\{[^}]*$/u, '').replace(/[เแโใไ]+$/u, '')}…`;
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
