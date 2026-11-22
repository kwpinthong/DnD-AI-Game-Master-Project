import { z } from 'zod';
import { GameMode, MemberRole } from './game.ts';
import { RoomEntry, Turn } from './room.ts';
import { Phase } from './scenario.ts';
import { GameTimelineResponse } from './timeline.ts';

/**
 * GET /api/game/log (GEN-037): the caller's game, read-only, as a summary + log. Works in the lobby, while
 * playing and after the end; nothing in it changes the game. It holds only what this viewer may see:
 * lobby names, the timeline as GET /api/game/timeline shows it to them, and the feed / narration /
 * whispers they received. The secret reveal at the end is GEN-059's, not here.
 */
export const GameLogStatus = z.enum(['lobby', 'playing', 'ended']);
export type GameLogStatus = z.infer<typeof GameLogStatus>;

/** `finale`: past day 12 NOCTHERION turn 2. `game_over`: everyone unconscious with nobody to wake (GEN-052). */
export const GameEndReason = z.enum(['finale', 'game_over']);
export type GameEndReason = z.infer<typeof GameEndReason>;

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
  }),
  you: z.strictObject({ memberId: z.string(), role: MemberRole }),
  /** Lobby names, join order; kicked members are left out. */
  members: z.array(z.strictObject({ name: z.string(), role: MemberRole })),
  timeline: GameTimelineResponse,
  /** Everything the room ever sent this viewer, oldest first (the same entries as a replay from seq 0). */
  entries: z.array(RoomEntry),
});
export type GameLogResponse = z.infer<typeof GameLogResponse>;
