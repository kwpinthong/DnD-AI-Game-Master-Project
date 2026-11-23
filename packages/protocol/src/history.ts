import { z } from 'zod';
import { GameMode, MemberRole } from './game.ts';
import { RoomEntry, Turn } from './room.ts';
import { Phase } from './scenario.ts';
import { GameTimelineResponse } from './timeline.ts';

/**
 * GET /api/game/log (GEN-037): the caller's game, read-only, as a summary + log. Works in the lobby, while
 * playing and after the end; nothing in it changes the game. It holds only what this viewer may see:
 * lobby names, the timeline as GET /api/game/timeline shows it to them, and the feed / narration /
 * whispers they received. After the end it also carries the secret reveal (GEN-059, `reveal`).
 */
export const GameLogStatus = z.enum(['lobby', 'playing', 'ended']);
export type GameLogStatus = z.infer<typeof GameLogStatus>;

/**
 * `finale`: past day 12 NOCTHERION turn 2. `game_over`: every player dead for good, an Astral Spirit (GEN-070).
 * `closed` (ISK-001): the server owner closed the game early.
 */
export const GameEndReason = z.enum(['finale', 'game_over', 'closed']);
export type GameEndReason = z.infer<typeof GameEndReason>;

/**
 * GEN-059 ending path: `good` (the miracle veil turns the meteor away), `evil` (its power is absorbed),
 * `neutral` (with Astra and Serena its effect is cancelled to zero), `none` (no path succeeded: the meteor
 * hits; only S / SS protection or a SAFE_ZONE survives). A game_over is `none`.
 */
export const EndingPath = z.enum(['good', 'evil', 'neutral', 'none']);
export type EndingPath = z.infer<typeof EndingPath>;

export const PlayerEndingOutcome = z.enum(['survived', 'defeated']);
export type PlayerEndingOutcome = z.infer<typeof PlayerEndingOutcome>;

/** One player's secrets, revealed on the summary page once the game ended (GEN-059 C5). */
export const GameRevealPlayer = z.strictObject({
  memberId: z.string(),
  /** The lobby name everyone saw. */
  lobbyName: z.string(),
  /** The character's real name (ชื่อจริง). */
  characterName: z.string(),
  /** Q-196: the karma tier word is the main label, the number goes small beside it. */
  karma: z.number().int(),
  karmaTier: z.string(),
  /** null = the ending was not decided (a game ended before GEN-059). */
  outcome: PlayerEndingOutcome.nullable(),
  /** Where the character was first placed (จุดเกิด); null = not recorded. */
  spawn: z.string().nullable(),
  /** Companion NPC names at the end, main first. */
  companions: z.array(z.string()),
  /** Every Secret action that stood, oldest first. */
  secretActions: z.array(
    z.strictObject({
      day: z.number().int(),
      phase: Phase,
      turn: Turn,
      text: z.string(),
      /** GEN-078: the action's ref the 👍 names (`${day}-${phase}-${turn}-${actionSeq}`, GEN-077 ADR). */
      sourceRef: z.string().optional(),
    }),
  ),
  /** Screens and Flows v2 §6 (Q-229): appearance, the last Social Title, the ending the GM told this player (null = not told yet). */
  appearance: z.string().optional(),
  finalTitle: z.string().optional(),
  epilogue: z.string().nullable().optional(),
});
export type GameRevealPlayer = z.infer<typeof GameRevealPlayer>;

export const GameReveal = z.strictObject({
  /** null = the ending was not decided (a game ended before GEN-059). */
  path: EndingPath.nullable(),
  /** Join order. */
  players: z.array(GameRevealPlayer),
});
export type GameReveal = z.infer<typeof GameReveal>;

export const GameLogResponse = z.strictObject({
  game: z.strictObject({
    id: z.string(),
    name: z.string(),
    mode: GameMode,
    humanGm: z.boolean(),
    status: GameLogStatus,
    endReason: GameEndReason.nullable(),
    /** Where the game is (or stopped); null before the start. */
    at: z.strictObject({ day: z.number().int(), phase: Phase, turn: Turn }).nullable(),
    startedAt: z.string().nullable(),
    /**
     * ISK-001: the server owner closed the game while it was played (no AI ending; the summary is the normal one).
     * The server always sends both; optional so older web fixtures still type.
     */
    closedEarly: z.boolean().optional(),
    closeReason: z.string().nullable().optional(),
  }),
  you: z.strictObject({ memberId: z.string(), role: MemberRole }),
  /** Lobby names, join order; kicked members are left out. */
  members: z.array(z.strictObject({ name: z.string(), role: MemberRole })),
  timeline: GameTimelineResponse,
  /** Everything the room ever sent this viewer, oldest first (the same entries as a replay from seq 0). */
  entries: z.array(RoomEntry),
  /**
   * GEN-059: the secret reveal, only once the game ended (status `ended`); null before. The only place a
   * player ever gets karma numbers or other players' real names / Secret actions.
   */
  reveal: GameReveal.nullable(),
});
export type GameLogResponse = z.infer<typeof GameLogResponse>;
