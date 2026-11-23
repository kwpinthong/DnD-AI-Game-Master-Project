import { z } from 'zod';
import { Phase } from './scenario.ts';

/**
 * ISK-010: a player's bug report / idea, read by the server owner in /admin. The text is kept as sent (trimmed)
 * and must be shown escaped; it is never sent to another player. Day / period / turn come from the game's own
 * state (null before the first turn), never from the client; game and member from the session.
 */

export const FeedbackType = z.enum(['bug', 'idea', 'other']);
export type FeedbackType = z.infer<typeof FeedbackType>;

export const FeedbackStatus = z.enum(['new', 'reviewing', 'done']);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;

/** The screen the report was sent from. */
export const FeedbackPage = z.enum(['lobby', 'character', 'loot', 'spawn', 'play', 'ending', 'other']);
export type FeedbackPage = z.infer<typeof FeedbackPage>;

export const FEEDBACK_TEXT_MAX = 1000;
export const FEEDBACK_USER_AGENT_MAX = 300;

/**
 * Body of POST /api/feedback. `text`: 1-1000 code points after trim (400 `text_required` / `text_too_long`);
 * `type` / `page` outside their lists: 400 `invalid_type` / `invalid_page`; `userAgent` longer than 300 is cut.
 * Anything else in the body (day, gameId, ...) is ignored.
 */
export const FeedbackInput = z.object({
  type: FeedbackType,
  text: z
    .string()
    .trim()
    .min(1, 'พิมพ์ข้อความก่อนส่ง')
    .refine((s) => [...s].length <= FEEDBACK_TEXT_MAX, `ยาวได้ไม่เกิน ${FEEDBACK_TEXT_MAX} ตัวอักษร`),
  page: FeedbackPage,
  userAgent: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : [...s].slice(0, FEEDBACK_USER_AGENT_MAX).join(''))),
});
export type FeedbackInput = z.input<typeof FeedbackInput>;

/** One stored report (201 from POST /api/feedback, 200 from PATCH /api/admin/feedback/:id). */
export const FeedbackRow = z.strictObject({
  id: z.number().int().min(1),
  gameId: z.string(),
  memberId: z.string(),
  type: FeedbackType,
  /** As sent (trimmed): render it as text, never as HTML. */
  text: z.string(),
  context: z.strictObject({
    day: z.number().int().nullable(),
    period: Phase.nullable(),
    turn: z.number().int().nullable(),
    page: FeedbackPage,
    userAgent: z.string(),
  }),
  status: FeedbackStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FeedbackRow = z.infer<typeof FeedbackRow>;

/** 200 from GET /api/admin/feedback(?status=&type=): the latest 200, newest first. */
export const AdminFeedbackResponse = z.strictObject({ feedback: z.array(FeedbackRow) });
export type AdminFeedbackResponse = z.infer<typeof AdminFeedbackResponse>;

/** Body of PATCH /api/admin/feedback/:id (another status: 400 `invalid_status`). */
export const AdminFeedbackStatusRequest = z.object({ status: FeedbackStatus });
export type AdminFeedbackStatusRequest = z.input<typeof AdminFeedbackStatusRequest>;
