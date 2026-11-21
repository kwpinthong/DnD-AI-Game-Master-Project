import { z } from 'zod';
import { Phase } from './scenario.ts';

/**
 * Timeline event runtime state (GEN-053, GDD §6.2). A scenario event is `pending` until the game
 * reaches its day + phase, `active` during that phase, and `resolved` once the game moves past it.
 */
export const EventStatus = z.enum(['pending', 'active', 'resolved']);
export type EventStatus = z.infer<typeof EventStatus>;

/** `default`: the scenario's ผลตั้งต้น (nobody stepped in). `ai`: set by the AI GM while the event was active. */
export const EventOutcomeSource = z.enum(['default', 'ai']);
export type EventOutcomeSource = z.infer<typeof EventOutcomeSource>;

/** Outcome text the AI GM may set on an active event (e.g. `prevented`). */
export const EventOutcomeText = z.string().trim().min(1, 'ห้ามว่าง').max(1000, 'ยาวได้ไม่เกิน 1000 ตัวอักษร');

export const PhasePoint = z.object({ day: z.number().int().min(1).max(12), phase: Phase });
export type PhasePoint = z.infer<typeof PhasePoint>;

/**
 * What a player sees of one event: only events that already began, and only their public title.
 * No description, outcome, NPCs or GM note (C5). `.strict()` so a new field is a deliberate change.
 */
export const PlayerTimelineEvent = z
  .object({ id: z.string(), day: z.number().int(), phase: Phase, title: z.string(), status: EventStatus.exclude(['pending']) })
  .strict();
export type PlayerTimelineEvent = z.infer<typeof PlayerTimelineEvent>;

/** The Human GM sees every event, pending ones and outcomes included. */
export const GmTimelineEvent = z
  .object({
    id: z.string(),
    day: z.number().int(),
    phase: Phase,
    title: z.string(),
    status: EventStatus,
    /** The AI's choice while active, or the final outcome once resolved; null = nothing chosen yet. */
    outcome: z.string().nullable(),
    outcomeSource: EventOutcomeSource.nullable(),
  })
  .strict();
export type GmTimelineEvent = z.infer<typeof GmTimelineEvent>;

/** 200 from GET /api/game/timeline. `at` is null before the game reaches day 1 Morning. */
export const GameTimelineResponse = z.discriminatedUnion('view', [
  z.object({ view: z.literal('player'), at: PhasePoint.nullable(), ended: z.boolean(), events: z.array(PlayerTimelineEvent) }).strict(),
  z.object({ view: z.literal('gm'), at: PhasePoint.nullable(), ended: z.boolean(), events: z.array(GmTimelineEvent) }).strict(),
]);
export type GameTimelineResponse = z.infer<typeof GameTimelineResponse>;
