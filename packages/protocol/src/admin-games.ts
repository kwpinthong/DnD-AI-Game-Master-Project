import { z } from 'zod';
import { MemberRole } from './game.ts';
import { GameEndReason } from './history.ts';
import { Phase } from './scenario.ts';

/**
 * ISK-001: the server owner's list of every game and the early close of one (admin token only).
 * `lobby` = not started; `setup` = started but nobody entered the play room yet (character / loot / origin);
 * `playing`; `ended` (finale, game_over or closed by the owner).
 */
export const AdminGamePhase = z.enum(['lobby', 'setup', 'playing', 'ended']);
export type AdminGamePhase = z.infer<typeof AdminGamePhase>;

export const AdminGameRow = z.strictObject({
  id: z.string(),
  name: z.string(),
  phase: AdminGamePhase,
  /** Set when `phase` is `ended`. */
  endedReason: GameEndReason.nullable(),
  /** Where the game is (or stopped); both null before the first turn. */
  day: z.number().int().nullable(),
  period: Phase.nullable(),
  playerCount: z.number().int(),
  /** The last change of the turn state; null before the first turn. */
  lastActionAt: z.string().nullable(),
  /** The game's AI cost so far, USD (estimate from the price table). */
  aiUsd: z.number(),
});
export type AdminGameRow = z.infer<typeof AdminGameRow>;

/** 200 from GET /api/admin/games: every game, the newest `lastActionAt` (else created time) first. */
export const AdminGamesResponse = z.strictObject({ games: z.array(AdminGameRow) });
export type AdminGamesResponse = z.infer<typeof AdminGamesResponse>;

/** Max length of the close reason, in code points (after trim). */
export const CLOSE_REASON_MAX = 200;

/**
 * Body of POST /api/admin/games/:id/close. `confirmName` must equal the game's name (trim + NFC);
 * `reason` is trimmed, ≤ 200 code points, empty = none.
 */
export const AdminCloseGameRequest = z.object({ confirmName: z.string(), reason: z.string().optional() });
export type AdminCloseGameRequest = z.infer<typeof AdminCloseGameRequest>;

/**
 * ISK-018: one member of a game for the server owner, kicked ones included (`kickedAt` ISO, null = in the game).
 * `ready` is the lobby ready mark (always false until ISK-017). Never a PIN hash or a session token.
 */
export const AdminMemberRow = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: MemberRole,
  hasCharacter: z.boolean(),
  ready: z.boolean(),
  kickedAt: z.string().nullable(),
});
export type AdminMemberRow = z.infer<typeof AdminMemberRow>;

/** 200 from GET /api/admin/games/:id/members and POST .../members/:memberId/kick: every member, join order. */
export const AdminMembersResponse = z.strictObject({ members: z.array(AdminMemberRow) });
export type AdminMembersResponse = z.infer<typeof AdminMembersResponse>;

/** ISK-098: one topic of what the AI remembers of a player (tokens {{p:ref}} / {{n:id}} only; `names` reads them). */
export const AdminMemoryTopic = z.strictObject({
  topicId: z.string(),
  title: z.string(),
  summary: z.string(),
  firstDay: z.number().int(),
  lastDay: z.number().int(),
});
export type AdminMemoryTopic = z.infer<typeof AdminMemoryTopic>;

/**
 * 200 from GET /api/admin/games/:id/memory (ISK-098): each player's memory topics, newest `lastDay` first.
 * `charCount` = code points of every title + summary (the count `maxChars` caps); `names` = each token the topics
 * use → its real name, for the server owner only. Players never get this.
 */
export const AdminPlayerMemory = z.strictObject({
  maxChars: z.number().int(),
  maxTopics: z.number().int(),
  players: z.array(z.strictObject({ memberId: z.string(), name: z.string(), charCount: z.number().int(), topics: z.array(AdminMemoryTopic) })),
  names: z.record(z.string(), z.string()),
});
export type AdminPlayerMemory = z.infer<typeof AdminPlayerMemory>;

/** 200 from POST /api/admin/games/:id/invite-code: the new code (the old one stops working at once). */
export const AdminInviteCodeResponse = z.strictObject({ inviteCode: z.string() });
export type AdminInviteCodeResponse = z.infer<typeof AdminInviteCodeResponse>;
