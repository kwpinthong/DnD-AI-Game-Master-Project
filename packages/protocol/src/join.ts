import { z } from 'zod';

/** Longest player name, counted in Unicode code points after normalisation (Thai marks count). */
export const NAME_MAX_LENGTH = 32;

/**
 * How a typed player name is stored and shown: NFKC, trimmed, runs of whitespace folded to one
 * space. Uniqueness inside a game uses `nameKey` on top of this (case-insensitive).
 */
export function normalizePlayerName(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/gu, ' ');
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
  pin: z.string({ error: PIN_MESSAGE }).regex(/^[0-9]{4,6}$/, PIN_MESSAGE),
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
  /** 403: wrong create code (POST /api/games). */
  z.object({ code: z.literal('wrong_create_code'), message: z.string() }),
  /** 429: too many wrong create codes on this server; try again after `retryAt`. */
  z.object({ code: z.literal('too_many_attempts'), message: z.string(), retryAt: z.string() }),
  /** 503: the server has no CREATE_CODE_HASH, so nobody can create a game. */
  z.object({ code: z.literal('create_disabled'), message: z.string() }),
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
]);
export type ApiError = z.infer<typeof ApiError>;
