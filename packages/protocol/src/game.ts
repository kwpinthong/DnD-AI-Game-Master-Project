import { z } from 'zod';
import { JoinRequest, Member } from './join.ts';

/** Online: 2-6 players. Single: exactly 1. A Human GM is not a player and has no character. */
export const ONLINE_MIN_PLAYERS = 2;
export const ONLINE_MAX_PLAYERS = 6;
export const GAME_NAME_MAX_LENGTH = 60;

export const GameMode = z.enum(['online', 'single']);
export type GameMode = z.infer<typeof GameMode>;

/** `gm` = the Human GM (the creator when the game has one); everyone else is a `player`. */
export const MemberRole = z.enum(['player', 'gm']);
export type MemberRole = z.infer<typeof MemberRole>;

/** Invite codes are shown as XXX-XXX; the server accepts them with or without the dash. */
export function formatInviteCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

const gameName = z
  .string({ error: 'กรุณาใส่ชื่อเกม' })
  .transform((raw) => raw.normalize('NFKC').trim().replace(/\s+/gu, ' '))
  .pipe(
    z
      .string()
      .min(1, 'กรุณาใส่ชื่อเกม')
      .refine((name) => [...name].length <= GAME_NAME_MAX_LENGTH, `ชื่อเกมยาวได้ไม่เกิน ${GAME_NAME_MAX_LENGTH} ตัวอักษร`),
  );

/**
 * Body of POST /api/games. The creator joins the new game in the same call with `name` + `pin`
 * (like POST /api/join) and becomes its owner: the GM when `humanGm`, otherwise its first player.
 * `createCode` is the server-level secret (Q-021), not the game's invite code.
 */
export const CreateGameRequest = z
  .object({
    createCode: z.string({ error: 'กรุณาใส่ create code' }).min(1, 'กรุณาใส่ create code').max(200, 'create code ยาวเกินไป'),
    gameName,
    mode: z.enum(GameMode.options, { error: 'เลือกโหมด Online หรือเล่นคนเดียว' }),
    humanGm: z.boolean({ error: 'เลือกว่ามี GM คนหรือไม่' }),
    name: JoinRequest.shape.name,
    pin: JoinRequest.shape.pin,
  })
  .refine((v) => !(v.mode === 'single' && v.humanGm), {
    path: ['humanGm'],
    message: 'เล่นคนเดียวใช้ AI GM เท่านั้น มี GM คนไม่ได้',
  });
export type CreateGameRequest = z.infer<typeof CreateGameRequest>;
export type CreateGameField = keyof z.input<typeof CreateGameRequest>;

/** First message per wrong field; empty object when the input is valid. */
export function createGameFieldErrors(input: unknown): Partial<Record<CreateGameField, string>> {
  const result = CreateGameRequest.safeParse(input ?? {});
  if (result.success) return {};
  const errors: Partial<Record<CreateGameField, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as CreateGameField | undefined;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/** Body of PATCH /api/game (owner only, before the game starts). */
export const UpdateGameRequest = z.object({
  gameName: gameName.optional(),
  mode: GameMode.optional(),
});
export type UpdateGameRequest = z.infer<typeof UpdateGameRequest>;

export const GameMember = z.object({
  id: z.string(),
  name: z.string(),
  role: MemberRole,
  isOwner: z.boolean(),
  /** Players only: whether their character is created (GEN-047 creates characters). */
  hasCharacter: z.boolean(),
});
export type GameMember = z.infer<typeof GameMember>;

/** 200 from GET /api/game and the owner actions: the caller's game as the lobby shows it. */
export const GameView = z.object({
  id: z.string(),
  name: z.string(),
  mode: GameMode,
  humanGm: z.boolean(),
  /** Normalised (no dash); show it with formatInviteCode. */
  inviteCode: z.string(),
  status: z.enum(['lobby', 'started']),
  startedAt: z.string().nullable(),
  you: z.object({ memberId: z.string(), role: MemberRole, isOwner: z.boolean() }),
  members: z.array(GameMember),
  players: z.object({ count: z.number().int(), min: z.number().int(), max: z.number().int() }),
  /**
   * The caller may open the scenario editor: the Human GM before the start. Games without a Human GM
   * use the default template and nobody edits it (Q-028); scenario content is never in this view.
   */
  canEditScenario: z.boolean(),
  /** Why the owner cannot start yet (Thai, one line each); empty when the game can start. */
  startBlockers: z.array(z.string()),
});
export type GameView = z.infer<typeof GameView>;

/** 200 from POST /api/games: the creator is logged in like after POST /api/join. */
export const CreateGameResponse = z.object({
  token: z.string(),
  expiresAt: z.string(),
  member: Member,
  game: GameView,
});
export type CreateGameResponse = z.infer<typeof CreateGameResponse>;
