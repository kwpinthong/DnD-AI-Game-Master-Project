import { z } from 'zod';

/** Longest player name, counted in Unicode code points after normalisation (Thai marks count). */
export const NAME_MAX_LENGTH = 32;

/**
 * How a typed player name is stored and shown: NFC (not NFKC, which splits sara am ำ U+0E33 into
 * U+0E4D U+0E32; GEN-106), trimmed, runs of whitespace folded to one space. A name typed with the
 * split form is joined back so it is the same name and key. Uniqueness inside a game uses `nameKey`
 * on top of this (case-insensitive).
 */
export function normalizePlayerName(raw: string): string {
  return raw.normalize('NFC').replace(/ํา/gu, 'ำ').trim().replace(/\s+/gu, ' ');
}

/** Key that decides "same player" inside one game: the normalised name, lower-cased. */
export function nameKey(raw: string): string {
  return normalizePlayerName(raw).toLowerCase();
}

/** Invite codes are stored upper-case with no spaces or dashes ("k7q-2mx" = "K7Q2MX"). */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[\s-]+/gu, '').toUpperCase();
}

const PIN_MESSAGE = 'PIN ต้องเป็นตัวเลข 4-6 หลัก';
const PIN_THAI_KEYBOARD_MESSAGE = `${PIN_MESSAGE} (แป้นพิมพ์อาจเป็นภาษาไทย ลองสลับเป็นภาษาอังกฤษ)`;
const THAI_DIGIT_ZERO = 0x0e50;

/**
 * How a typed PIN is read (GEN-092): outer whitespace off and Thai digits ๐-๙ as 0-9, so a PIN
 * typed on a Thai keyboard is the same PIN as the Arabic one. Anything else is left for the check.
 */
export function normalizePin(raw: string): string {
  return raw.trim().replace(/[๐-๙]/gu, (digit) => String(digit.charCodeAt(0) - THAI_DIGIT_ZERO));
}

const pin = z
  .string({ error: PIN_MESSAGE })
  .transform(normalizePin)
  .pipe(
    z.string().superRefine((value, ctx) => {
      if (/^[0-9]{4,6}$/.test(value)) return;
      // Thai letters here mostly mean the number row was typed with the Thai layout (ๅ/-ภถ...).
      ctx.addIssue({ code: 'custom', message: /[฀-๿]/u.test(value) ? PIN_THAI_KEYBOARD_MESSAGE : PIN_MESSAGE });
    }),
  );

/** Body of POST /api/join. PIN is a string so leading zeros survive. */
export const JoinRequest = z.object({
  inviteCode: z
    .string({ error: 'กรุณาใส่โค้ดเกม' })
    .transform(normalizeInviteCode)
    .pipe(z.string().min(1, 'กรุณาใส่โค้ดเกม')),
  name: z
    .string({ error: 'กรุณาใส่ชื่อผู้เล่น' })
    .transform(normalizePlayerName)
    .pipe(
      z
        .string()
        .min(1, 'กรุณาใส่ชื่อผู้เล่น')
        .refine((name) => [...name].length <= NAME_MAX_LENGTH, `ชื่อยาวได้ไม่เกิน ${NAME_MAX_LENGTH} ตัวอักษร`),
    ),
  pin,
});
export type JoinRequest = z.infer<typeof JoinRequest>;

export type JoinField = keyof z.input<typeof JoinRequest>;
export type JoinFieldErrors = Partial<Record<JoinField, string>>;

/** First message per wrong field; empty object when the input is valid. */
export function joinFieldErrors(input: unknown): JoinFieldErrors {
  const result = JoinRequest.safeParse(input ?? {});
  if (result.success) return {};
  const errors: JoinFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as JoinField | undefined;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

export const Member = z.object({
  id: z.string(),
  gameId: z.string(),
  name: z.string(),
});
export type Member = z.infer<typeof Member>;

/** 200 from POST /api/join. Send `token` as `Authorization: Bearer <token>` afterwards. */
export const JoinResponse = z.object({
  token: z.string(),
  expiresAt: z.string(),
  /** true when this join created the member (first time with this name in this game). */
  created: z.boolean(),
  member: Member,
});
export type JoinResponse = z.infer<typeof JoinResponse>;

/** 200 from GET /api/me. */
export const MeResponse = z.object({ member: Member });
export type MeResponse = z.infer<typeof MeResponse>;

/** Every non-2xx answer of the /api routes. `message` is Thai text for the player. */
export const ApiError = z.discriminatedUnion('code', [
  /** 400. `fields` maps request field names to their first error. */
  z.object({ code: z.literal('invalid_input'), message: z.string(), fields: z.record(z.string(), z.string()) }),
  z.object({ code: z.literal('game_not_found'), message: z.string() }),
  z.object({ code: z.literal('wrong_pin'), message: z.string(), attemptsLeft: z.number().int() }),
  z.object({ code: z.literal('locked'), message: z.string(), retryAt: z.string() }),
  z.object({ code: z.literal('unauthorized'), message: z.string() }),
  /** 403: the owner removed this member; the name cannot join this game again. */
  z.object({ code: z.literal('kicked'), message: z.string() }),
  /** 409: no room for another player (Online has 6, Single has its 1). */
  z.object({ code: z.literal('game_full'), message: z.string() }),
  /** 409: mode and members are locked once the game has started. */
  z.object({ code: z.literal('game_started'), message: z.string() }),
  /** 409 (ISK-015): a started Single game takes nobody new. */
  z.object({ code: z.literal('single_mode'), message: z.string() }),
  /** 409 (ISK-015): a started game takes newcomers up to day 9 only (checked at join time). */
  z.object({ code: z.literal('join_closed_day'), message: z.string() }),
  /** 409 (ISK-015): the game has ended (finale / game over); POST /api/join and POST /api/game/spawn. */
  z.object({ code: z.literal('game_ended'), message: z.string() }),
  /** 403: wrong create code (POST /api/games). */
  z.object({ code: z.literal('wrong_create_code'), message: z.string() }),
  /** 429: too many wrong create codes on this server; try again after `retryAt`. */
  z.object({ code: z.literal('too_many_attempts'), message: z.string(), retryAt: z.string() }),
  /** 503: the server has no CREATE_CODE_HASH, so nobody can create a game. */
  z.object({ code: z.literal('create_disabled'), message: z.string() }),
  /** 403 (GEN-061): wrong admin code at POST /api/admin/session. */
  z.object({ code: z.literal('wrong_admin_code'), message: z.string() }),
  /** 503 (GEN-061): the server has no ADMIN_CODE_HASH, so nobody can open the AI usage dashboard. */
  z.object({ code: z.literal('admin_disabled'), message: z.string() }),
  /** 403: only the game's owner may do this. */
  z.object({ code: z.literal('forbidden'), message: z.string() }),
  /** 404: no such member in the caller's game. */
  z.object({ code: z.literal('member_not_found'), message: z.string() }),
  /** 409: the change is not allowed in the game's current state (e.g. Single with 2 players). */
  z.object({ code: z.literal('not_allowed'), message: z.string() }),
  /** 409 from POST /api/game/start; `reasons` lists what is missing (Thai, one line each). */
  z.object({ code: z.literal('cannot_start'), message: z.string(), reasons: z.array(z.string()) }),
  /** 503 from POST /api/games and POST /api/game/start: the AI GM provider is not ready (e.g. no API key). */
  z.object({ code: z.literal('ai_not_ready'), message: z.string() }),
  /** 409: this member already has a character in this game (one per member per game). */
  z.object({ code: z.literal('character_exists'), message: z.string() }),
  /** 404: the caller has no character to edit yet. */
  z.object({ code: z.literal('character_not_found'), message: z.string() }),
  /** 503: the AI gave no usable answer after its retries; nothing changed, try again (GEN-048 C5). */
  z.object({ code: z.literal('ai_unavailable'), message: z.string() }),
  /** 409: the loot step is already done, or the reroll quota is used up (GEN-048). */
  z.object({ code: z.literal('loot_closed'), message: z.string() }),
  /** 409: choose was called before any offer exists. */
  z.object({ code: z.literal('loot_no_offer'), message: z.string() }),
  /** 409: the player already keeps 3 NPCs; release one first (GEN-054). */
  z.object({ code: z.literal('companion_limit'), message: z.string() }),
  /** 403 (GEN-121): the caller does not know that NPC yet (its name is still hidden), so it cannot be saved as a companion. */
  z.object({ code: z.literal('not_acquainted'), message: z.string() }),
  /** 404: no NPC with that ref at the caller's place, or (release) not one of the caller's companions. */
  z.object({ code: z.literal('npc_not_found'), message: z.string() }),
  /** 404 (GEN-078): the `sourceRef` names no action → result row the end page of the caller's game shows. */
  z.object({ code: z.literal('ruling_not_found'), message: z.string() }),
  /** 404 (GEN-107): no AI-written room entry with that id in the caller's game (also a player's own text, or a server template). */
  z.object({ code: z.literal('response_not_found'), message: z.string() }),
  /** 404 (GEN-147): no game data set with that name. */
  z.object({ code: z.literal('data_set_not_found'), message: z.string() }),
  /** 400 (ISK-001): the typed name is not the game's name. */
  z.object({ code: z.literal('confirm_required'), message: z.string() }),
  /** 400 (ISK-001): the close reason is over 200 characters. */
  z.object({ code: z.literal('reason_too_long'), message: z.string() }),
  /** 409 (ISK-001): the game already ended (or was closed); nothing changed. */
  z.object({ code: z.literal('already_ended'), message: z.string() }),
  /** 409 (ISK-001): the server owner closed this game; nothing changes any more. */
  z.object({ code: z.literal('game_closed'), message: z.string() }),
  /** 404 (ISK-001): the game was closed before it was played, so it has no end page. */
  z.object({ code: z.literal('not_started'), message: z.string() }),
  /** 400 (ISK-010): POST /api/feedback with no text, too long a text, or a type / page outside the lists. */
  z.object({ code: z.literal('text_required'), message: z.string() }),
  z.object({ code: z.literal('text_too_long'), message: z.string() }),
  z.object({ code: z.literal('invalid_type'), message: z.string() }),
  z.object({ code: z.literal('invalid_page'), message: z.string() }),
  /** 400 (ISK-010): a feedback status outside new / reviewing / done. */
  z.object({ code: z.literal('invalid_status'), message: z.string() }),
  /** 429 (ISK-010): 5 reports in the last 10 minutes from this member. */
  z.object({ code: z.literal('rate_limited'), message: z.string() }),
  /** 404 (ISK-010): no feedback with that id. */
  z.object({ code: z.literal('feedback_not_found'), message: z.string() }),
  /** 400 (ISK-006): no avatarId, or one that is not a preset avatar. */
  z.object({ code: z.literal('invalid_avatar'), message: z.string() }),
  /** 400 (ISK-006): a chip category is missing, or its value is not one offered now; `field` names the category. */
  z.object({ code: z.literal('invalid_trait'), message: z.string(), field: z.string() }),
  /** 400 (ISK-006): the appearance free text is over 80 code points. */
  z.object({ code: z.literal('extra_too_long'), message: z.string() }),
  /** 400 (ISK-006): the appearance free text holds an NPC's real name or a {{ }} token. */
  z.object({ code: z.literal('extra_forbidden'), message: z.string() }),
]);
export type ApiError = z.infer<typeof ApiError>;
